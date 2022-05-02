import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';
import {Encoder, is_better_member_compression, base64} from './encoder.js';
import {
	hex_cp, parse_cp, parse_cp_range, parse_cp_sequence, parse_cp_multi_ranges,
	map_values, take_from, set_union, set_intersect, set_complement, split_on, compare_arrays, explode_cp
} from './utils.js';
import {read_parsed} from './nodejs-utils.js';

let base_dir = new URL('./', import.meta.url).pathname;

function ensure_dir(name) {
	let dir = join(base_dir, name);
	mkdirSync(dir, {recursive: true});
	return dir;
}

class IDNA {
	constructor(config = {}) {
		this.config = config;
		this.valid = new Set();
		this.ignored = new Set();
		this.mapped = [];
	}
	remove_rule(cp) {
		if (this.ignored.delete(cp)) return true;
		if (this.valid.delete(cp)) return true;
		let pos = this.mapped.findIndex(([x]) => cp == x);
		if (pos >= 0) {
			this.mapped.splice(pos, 1);
			return true;
		}
		return false;
	}
	is_mapped(cp) {
		return this.mapped.some(([x]) => x == cp)
	}
	is_disallowed(cp) {
		return !this.valid.has(cp) && !this.ignored.has(cp) && !this.is_mapped(cp);
	}
	allowed_set() {
		return new Set([...this.valid, ...this.mapped.map(([x]) => x)]);
	}
	check_invariants() {
		// everything in the mapped output should be valid
		for (let [x, ys] of this.mapped) {
			if (this.valid.has(x)) {
				throw new Error(`Invalid rules: mapped target is valid: ${x}`);
			}
			if (this.ignored.has(x)) {
				throw new Error(`Invalid rules: mapped target is ignored: ${x}`);
			}
  			if (!ys.every(cp => this.valid.has(cp))) {
				throw new Error(`Invalid rules: mapped output isn't valid: ${x} -> ${ys}`);
			}
		}
		if (set_intersect(this.valid, this.ignored).size > 0) {
			throw new Error(`Invalid rules: valid intersects ignored`);
		}
	}
	check_assumptions() {
		// check some assumptions:
		// 1.) emoji styling should be ignored
		if (!this.ignored.has(0xFE0E)) throw new Error('Assumption wrong: FE0E not ignored');
		if (!this.ignored.has(0xFE0F)) throw new Error('Assumption wrong: FE0F not ignored');		
		// 2.) joiners should be valid if using context rules
		// note: this doesn't impact emoji zwj processing
		if (!this.valid.has(0x200C)) throw new Error('Assumption wrong: ZWNJ not valid');
		if (!this.valid.has(0x200D)) throw new Error('Assumption wrong: ZWJ not valid');		
	}
}

class UTS51 {
	constructor(data) {
		// sets of codepoints
		this.STYLE_DROP = new Set(); 
		this.STYLE_OPT = new Set();
		this.STYLE_REQ = new Set();
		this.NON_SOLO = new Set(); // experimental
		this.KEYCAP_DROP = new Set();
		this.KEYCAP_REQ = new Set();
		this.REGIONAL = new Set();
		this.TAG_SPEC = new Set();
		this.MOD_BASE = new Set();
		this.MODIFIER = new Set();
		// sets of strings
		this.SEQS = new Set(); 
		this.ZWJS = new Set(); 
		//this.data = data;
		this.emoji = new Set(data.Emoji);
		//this.picto = data.Extended_Pictographic.filter(cp => !this.emoji.has(cp));
		// check that Emoji_Presentation is a subset of emoji
		if (data.Emoji_Presentation.some(cp => !this.emoji.has(cp))) {
			throw new Error(`Assumption wrong: Emoji_Presentation not emoji`);
		}
		// check that Emoji_Modifier_Base is a subset of emoji
		if (data.Emoji_Modifier_Base.some(cp => !this.emoji.has(cp))) {
			throw new Error(`Assumption wrong: Emoji_Modifier_Base not emoji`);
		}
		// check that Emoji_Modifier is a subset of emoji
		if (data.Emoji_Modifier.some(cp => !this.emoji.has(cp))) {
			throw new Error(`Assumption wrong: Emoji_Modifier are emoji`);
		}
		// start with all the emoji as optional
		for (let cp of this.emoji) {
			this.STYLE_OPT.add(cp);
		}
		// assign modifier_base
		for (let cp of data.Emoji_Modifier_Base) {
			this.MOD_BASE.add(cp);
		}
		// assign modifier
		for (let cp of data.Emoji_Modifier) {
			this.MODIFIER.add(cp);
		}
		// assign regional
		for (let cp of data.regional) {
			this.remove_style(cp); // remove from normal emoji handling 
			this.REGIONAL.add(cp); 
		}
		// assign tag spec
		for (let cp of data.tag_spec) {
			this.TAG_SPEC.add(cp); // note: these are not emoji
		}
		// assign keycaps
		for (let cp of data.keycaps) {
			this.KEYCAP_REQ.add(cp);
		}
	}
	set_style(cp, key) {
		if (!this.emoji.has(cp)) throw new Error(`styling a non-emoji: ${cp}`);
		this.remove_style(cp);
		switch (key) {
			case 'style-req': this.STYLE_REQ.add(cp); break;
			case 'style-opt': this.STYLE_OPT.add(cp); break;
			case 'style-drop': this.STYLE_DROP.add(cp); break;
			default: throw new Error(`unknown style: ${key}`);
		}
	}
	remove_style(cp) {
		if (this.STYLE_DROP.delete(cp)) return true;
		if (this.STYLE_OPT.delete(cp)) return true;
		if (this.STYLE_REQ.delete(cp)) return true;
		return false;
	}
	group_seq() {
		let groups = {};
		for (let seq of this.SEQS) {
			let cps = explode_cp(seq);
			let key = cps.length;
			let bucket = groups[key];
			if (!bucket) groups[key] = bucket = [];
			bucket.push(cps);
		}
		return groups;		
	}
	group_zwj() {
		let valid_set = set_union(this.STYLE_DROP, this.STYLE_OPT, this.STYLE_REQ); 
		let valid_idx = [...valid_set].sort((a, b) => a - b);
		let groups = {};
		for (let seq of this.ZWJS) {
			let cps0 = explode_cp(seq);
			let parts = split_on(cps0.filter(cp => cp != 0xFE0F), 0x200D);
			if (parts.length == 1) {
				console.error(cps0);
				throw new Error(`Assumption wrong: ZWJ sequence without ZWJ`);
			} 
			let cps = parts.flat(); // joiners removed
			if (cps.some(cp => !valid_set.has(cp))) {
				console.error(cps0);
				throw new Error(`Assumption wrong: ZWJ sequence contains invalid emoji`);
			}
			let key = parts.map(v => v.length).join();
			let bucket = groups[key];
			if (!bucket) groups[key] = bucket = [];
			bucket.push(cps.map(cp => valid_idx.indexOf(cp))); // reindex
		}
		return groups;
	}
	check_assumptions() {
		// no SEQ or ZWJ should start with a modifier
		for (let s of this.SEQS) {
			if (this.MODIFIER.has(s.codePointAt(0))) {
				throw new Error(`Assumption wrong: SEQ starts with MODIFIER: ${s}`);
			}
		}
		for (let s of this.ZWJS) {
			if (this.MODIFIER.has(s.codePointAt(0))) {
				throw new Error(`Assumption wrong: ZWJ starts with MODIFIER: ${s} `);
			}
		}
		// MOD_BASE/MODIFIER should be DROP
		for (let cp of this.MOD_BASE) {
			if (!this.STYLE_DROP.has(cp)) {
				throw new Error(`Assumption wrong: MOD_BASE is not DROP: ${cp}`);
			}
		}
		for (let cp of this.MODIFIER) {
			if (!this.STYLE_DROP.has(cp)) {
				throw new Error(`Assumption wrong: MODIFIER is not DROP: ${cp}`);
			}
		}
	}
}

// this is used by two separate sub-libraries
const VIRAMA_COMBINING_CLASS = 9;

let [mode, ...argv] = process.argv.slice(2);
if (mode === undefined) throw new Error('expected mode');
switch (mode) {
	// ============================================================
	// build various payloads
	// ============================================================
	case 'all': {
		[
			'context', 'nf', 'bidi', 
			'release', 'adraffy', 
			'adraffy-exp', 'adraffy-compat', 
			'UTS51', 'others'
		].forEach(create_payload);
		break;
	}
	case 'sub': {
		['context', 'nf', 'bidi'].forEach(create_payload);
		break;
	}
	// ============================================================
	// simple queries
	// ============================================================
	case 'emoji-data': {
		let emoji = read_emoji_data();
		if (argv.length == 0) { // just output to console
			console.log(emoji);
			break;
		}
		writeFileSync(join(ensure_dir('output'), 'emoji-data.json'), JSON.stringify(emoji));
		break
	}
	case 'missing-emoji': {
		// find the emoji that are missing from ENS0
		let {idna} = read_rules_for_ENS0();
		let emoji_seq = map_values(read_parsed('emoji-sequences'), e => e.flatMap(({src}) => {
			return src.includes('..') ? parse_cp_range(src).map(x => [x]) : [parse_cp_sequence(src)]
		}));
		// include all of the singular basic emoji
		let basic = take_from(emoji_seq.Basic_Emoji, v => v.length == 1).flat();
		// include all of the styled emoji 
		let styled = take_from(emoji_seq.Basic_Emoji, v => v.length == 2 && v[1] == 0xFE0F).flatMap(([x]) => x)
		// assert there is nothing left
		if (emoji_seq.Basic_Emoji.length > 0) {
			throw new Error(`Assumption wrong: there are other basic emoji!`);
		}
		let missing = [basic, styled].flat().filter(cp => idna.is_disallowed(cp)).sort((a, b) => a - b); // sort
		console.log(missing.map(cp => ({dec: cp, hex: hex_cp(cp)})));
		//console.log(JSON.stringify(missing));
		break;
	}
	case 'diff': {
		// find the differences in allowed between the two
		let {idna: idna_ENS0} = read_rules_for_ENS0();
		let idna_2008 = read_idna_rules({version: 2008});
		let only_ENS0 = set_complement(idna_ENS0.allowed_set(), idna_2008.allowed_set()); // valid + mapped
		let only_2008 = set_complement(idna_2008.allowed_set(), idna_ENS0.allowed_set());
		if (only_2008.size !== 0) {
			console.log([...only_2008]);
			throw new Error('Assumption wrong: IDNA 2008 enabled something');
		}
		let without_emoji = set_complement(only_ENS0, read_emoji_data().Emoji); // remove emoji
		if (argv.length == 0) { // just output to console
			console.log([...without_emoji]);
			break;
		}
		writeFileSync(join(ensure_dir('output'), 'idna-diff-ENS0vs2008.json'), JSON.stringify([...without_emoji]));
		break;
	}
	case 'cm': {
		// dump the combining marks that are valid in IDNA 2008
		let v = [...set_intersect(
			read_combining_marks(), 
			read_idna_rules({version: 2008}).allowed_set()
		)].sort((a, b) => a - b);
		console.log(v.map(cp => ({dec: cp, hex: hex_cp(cp)})));
		//console.log(JSON.stringify(v));
		break;
	}	
	// ============================================================
	// dump generated rule files
	// ============================================================
	case 'emoji-zwj': {
		// find the RGI zwj sequences
		let seqs = read_parsed('emoji-zwj-sequences').map(({src}) => parse_cp_sequence(src));
		if (argv.length == 0) { // just output to console
			console.log(seqs);
			break;
		}
		writeFileSync(join(ensure_dir('rules'), 'emoji-zwj.js'), [
			`// generated: ${new Date().toJSON()}`,
			`export default [`,
			...seqs.map(v => `{ty: 'emoji-zwj', src: '${v.map(hex_cp).join(' ')}'}, // ${String.fromCodePoint(...v)}`),
			'];'
		].join('\n'));
		break;
	}
	case 'emoji-seq': {
		// find all the remaining sequences
		// as of 20220104: this is just Tags
		let tags = read_parsed('emoji-sequences').RGI_Emoji_Tag_Sequence.map(({src}) => parse_cp_sequence(src));
		if (argv.length == 0) {
			console.log(tags);
			break;
		}
		writeFileSync(join(ensure_dir('rules'), 'emoji-seq.js'), [
			`// generated: ${new Date().toJSON()}`,
			`export default [`,
			...tags.map(v => `{ty: 'emoji-seq', src: '${v.map(hex_cp).join(' ')}'}, // ${String.fromCodePoint(...v)}`),
			'];'
		].join('\n'));
		break;
	}
	case 'style-drop': {	
		// find the emoji that are valid in ENS0
		let {idna} = read_rules_for_ENS0();
		let {Emoji} = read_emoji_data();
		let valid = Emoji.filter(cp => idna.valid.has(cp));
		if (argv.length == 0) { // just output to console
			console.log(valid);
			break;
		}
		// write file
		writeFileSync(join(ensure_dir('rules'), 'style-drop.js'), [
			`// generated: ${new Date().toJSON()}`,
			`export default [`,
			...valid.map(cp => `{ty:'style-drop', src: '${hex_cp(cp)}'}, // ${String.fromCodePoint(cp)}`),
			'];'
		].join('\n'));
		break;
	}
	case 'demoji': {
		// find the emoji that are mapped by ENS0
		let {idna} = read_rules_for_ENS0();
		let {Emoji} = read_emoji_data();
		let mapped = idna.mapped.filter(([x]) => Emoji.includes(x));
		let invalid = Emoji.filter(cp => !idna.valid.has(cp) && !idna.is_mapped(cp));
		if (argv.length == 0) { // just output to console
			console.log({mapped, invalid});
			break;
		}
		// write file
		writeFileSync(join(ensure_dir('rules'), 'demoji.js'), [
			`// generated: ${new Date().toJSON()}`,
			`export default [`,
			...mapped.map(([x, ys]) => `{ty: 'demoji', src: '${hex_cp(x)}', dst: '${ys.map(hex_cp).join(' ')}'}, // ${String.fromCodePoint(x)} -> ${String.fromCodePoint(...ys)}`),
			...invalid.map(x => `{ty: 'demoji', src: '${hex_cp(x)}'}, // ${String.fromCodePoint(x)}`),
			'];'
		].join('\n'));
		break;
	}
	default: await create_payload(mode);
}


async function create_payload(name) {
	switch (name) {
		case 'release': {
			let idna = read_idna_rules({version: 2008});
			let uts51 = new UTS51(read_emoji_data());
			apply_rules(idna, uts51, (await import('./rules/adraffy.js')).default);
			idna.check_assumptions();
			uts51.check_assumptions();
			write_release_payload_v1('1', {idna, uts51});
			break;
		}
		case 'adraffy': {
			let idna = read_idna_rules({version: 2008});
			let uts51 = new UTS51(read_emoji_data());
			apply_rules(idna, uts51, (await import('./rules/adraffy.js')).default);
			idna.check_assumptions();
			uts51.check_assumptions();
			write_rules_payload('adraffy', {idna, uts51});
			break;
		}
		case 'adraffy-exp': {
			// adraffy with additional whitelist
			let idna = read_idna_rules({version: 2008});
			let uts51 = new UTS51(read_emoji_data());
			apply_rules(idna, uts51, [
				(await import('./rules/adraffy.js')).default,
				(await import('./rules/whitelist.js')).default
			].flat());
			idna.check_assumptions();
			uts51.check_assumptions();
			write_rules_payload('adraffy-exp', {idna, uts51});
			break;
		}
		case 'adraffy-compat': {
			// ENS0 with emoji
			let idna = read_idna_rules({version: 2003, valid_deviations: true});
			let uts51 = new UTS51(read_emoji_data());
			apply_rules(idna, uts51, (await import('./rules/adraffy.js')).default);
			idna.check_assumptions();
			uts51.check_assumptions();
			write_rules_payload('adraffy-compat', {idna, uts51});
			break;
		}
		case 'UTS51': {
			let idna = new IDNA();
			idna.ignored.add(0xFE0E); // only non-emoji character allowed
			let uts51 = new UTS51(read_emoji_data());
			uts51.ZWJS = undefined; // disable whitelist
			apply_rules(idna, uts51, []);
			write_rules_payload('UTS51', {idna, stops: new Set(), uts51, combining_marks: new Set()});
			break;
		}		
		case 'others': {
			// legacy ENS 
			write_rules_payload('ENS0', read_rules_for_ENS0());
			// 2003 with deviations (for IDNATestV2)
			write_rules_payload('UTS46', {idna: read_idna_rules({version: 2003, valid_deviations: true})});
			// true specs
			write_rules_payload('2003', {idna: read_idna_rules({version: 2003})});
			write_rules_payload('2008', {idna: read_idna_rules({version: 2008})});
			break;
		}
		case 'nf': {
			let enc = new Encoder();
			encode_nf(enc, read_nf_rules());
			write_payload('nf', enc);
			break;
		}
		case 'bidi': {
			let enc = new Encoder();
			encode_bidi(enc, read_bidi_rules());
			write_payload('bidi', enc);
			break;
		}
		case 'context': {
			let enc = new Encoder();
			encode_context(enc, read_context_rules());
			write_payload('context', enc);
			break;
		}
		/*
		case 'single-script': {
			let enc = new Encoder();
			encode_single_script(enc, read_single_script_rules());
			write_payload('single-script', enc);
			break;
		}
		*/
		default: throw new Error(`unknown payload: ${name}`);
	}
}

function read_emoji_data() {
	return {
		...map_values(read_parsed('emoji-data'), e => e.flatMap(parse_cp_range)),
		// these exist in emoji-data
		// but can only be identified 
		// by parsing the comments
		keycaps: parse_cp_multi_ranges('23 2A 30..39'),
		regional: parse_cp_multi_ranges('1F1E6..1F1FF'),
		tag_spec: parse_cp_multi_ranges('E0020..E007E')
	};
}

function read_combining_marks() {
	return new Set(Object.entries(read_parsed('DerivedGeneralCategory'))
		.filter(([k]) => k.startsWith('M'))
		.flatMap(([_, v]) => v.flatMap(parse_cp_range)));
}

function read_rules_for_ENS0() {	
	return {
		idna: read_idna_rules({version: 2003, valid_deviations: true}),
		combining_marks: new Set()
	};
}
function read_idna_rules({use_STD3 = true, version = 2008, valid_deviations = false}) {
	let {
		ignored,
		mapped,
		valid, 
		valid_NV8,
		valid_XV8,
		deviation_mapped,
		deviation_ignored,
		disallowed,
		disallowed_STD3_mapped,
		disallowed_STD3_valid,
		...extra
	} = read_parsed('IdnaMappingTable');
	if (Object.keys(extra).length > 0) {
		throw new Error(`Assumption wrong: Unknown IDNA Keys: ${Object.keys(extra)}`);
	}
	if (!use_STD3) {
		// disallowed_STD3_valid: the status is disallowed if UseSTD3ASCIIRules=true (the normal case); 
		// implementations that allow UseSTD3ASCIIRules=false would treat the code point as valid.
		valid.push(...disallowed_STD3_valid);
		// disallowed_STD3_mapped: the status is disallowed if UseSTD3ASCIIRules=true (the normal case); 
		// implementations that allow UseSTD3ASCIIRules=false would treat the code point as mapped.
		mapped.push(...disallowed_STD3_mapped);
	}
	if (version == 2003) {
		// There are two values: NV8 and XV8. NV8 is only present if the status is valid 
		// but the character is excluded by IDNA2008 from all domain names for all versions of Unicode. 
		valid.push(...valid_NV8);
		// XV8 is present when the character is excluded by IDNA2008 for the current version of Unicode.
		valid.push(...valid_XV8);
	} 
	// IDNA2008 allows the joiner characters (ZWJ and ZWNJ) in labels. 
	// By contrast, these are removed by the mapping in IDNA2003.
	if (version == 2008 || valid_deviations) { 
		valid.push(...deviation_mapped.map(([x]) => x));
		valid.push(...deviation_ignored);
	} else {
		mapped.push(...deviation_mapped);
		ignored.push(...deviation_ignored);
	}
	let idna = new IDNA({use_STD3, version, valid_deviations});
	idna.valid = new Set(valid.flatMap(parse_cp_range));
	idna.ignored = new Set(ignored.flatMap(parse_cp_range));
	// x:[char] => ys:[char, char, ...]
	idna.mapped = mapped.flatMap(([src, dst]) => {
		let cps = parse_cp_sequence(dst);
		// we need to re-apply the rules to the mapped output
		return cps.some(cp => idna.ignored.has(cp) || !idna.valid.has(cp)) ? [] : parse_cp_range(src).map(x => [x, cps]);
	});
	return idna;
}
function encode_idna(enc, {valid, ignored, mapped}) {	
	enc.write_member(valid);
	// ignored is the same thing as map to []
	// but it doesn't compress as well
	// likely because it breaks ranges
	enc.write_member(ignored);
	enc.write_mapped([
		[1, 1, 1], // alphabets: ABC
		[1, 2, 2], // paired-alphabets: AaBbCc
		[1, 1, 0], // \ 
		[2, 1, 0], //  adjacent that map to a constant
		[3, 1, 0]  // /   eg. AAAA..BBBB => CCCC
	], mapped);
}

function read_bidi_rules() {
	let src = read_parsed('DerivedBidiClass');
	let ret = {};
	for (let key of ['R', 'L', 'AL', 'AN', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']) {
		let v = src[key];
		if (!v) throw new Error(`Assumption wrong: Expected Bidi Class ${key}`);
		ret[key] = new Set(v.flatMap(parse_cp_range));
	}
	return ret;
	//return map_values(read_parsed('DerivedBidiClass'), v => new Set(v.flatMap(parse_cp_range)));
}
function encode_bidi(enc, {R, L, AL, AN, EN, ES, CS, ET, ON, BN, NSM}) {
	let R_AL_parts = [R, AL];
	let R_AL = set_union(...R_AL_parts);
	if (!is_better_member_compression([R_AL], R_AL_parts)) {
		throw new Error(`Assumption wrong: R_AL`);
	}
	let ECTOB_parts = [ES, CS, ET, ON, BN];
	let ECTOB = set_union(...ECTOB_parts);
	if (!is_better_member_compression([ECTOB], ECTOB_parts)) {
		throw new Error(`Assumption wrong: ECTOB`);
	}
	enc.write_member(R_AL);
	enc.write_member(L);
	enc.write_member(AN);
	enc.write_member(EN);
	enc.write_member(ECTOB);
	enc.write_member(NSM);
}

function read_nf_rules() {
	let combining_class = read_parsed('DerivedCombiningClass');
	delete combining_class['0']; // we dont need class 0
	combining_class = Object.entries(combining_class)
		.map(([k, v]) => [parseInt(k), new Set(v.flatMap(parse_cp_range))])
		.sort((a, b) => a[0] - b[0]);
	
	let virama_index = combining_class.findIndex(([cls]) => cls == VIRAMA_COMBINING_CLASS);
	if (virama_index < 0) {
		throw new Error(`Assumption wrong: no virama`);
	}
	
	let combining_rank = combining_class.map(([_, v]) => v); // drop the class, we just need order

	// this does not contain hangul
	let decomp = read_parsed('Decomposition_Mapping')
		.map(([x, ys]) => [parse_cp(x), parse_cp_sequence(ys)])
		.sort((a, b) => a[0] - b[0]);

	let comp_exclusions = new Set(read_parsed('CompositionExclusions').flatMap(parse_cp_range));
	
	return {combining_rank, comp_exclusions, decomp, virama_index};
}
function encode_nf(enc, {combining_rank, comp_exclusions, decomp}) {
	enc.unsigned(combining_rank.length);
	for (let c of combining_rank) enc.write_member(c);
	enc.write_mapped([	
		[1, 1, 1],
		[1, 1, 0]
	], decomp);
	enc.write_member(comp_exclusions);
}

function read_context_rules() {
	let {T, L, R, D} = map_values(read_parsed('DerivedJoiningType'), v => new Set(v.flatMap(parse_cp_range)));
	let {Greek, Hebrew, Hiragana, Katakana, Han} = map_values(read_parsed('Scripts'), v => new Set(v.flatMap(parse_cp_range)));
	let Virama = new Set(read_parsed('DerivedCombiningClass')[VIRAMA_COMBINING_CLASS].flatMap(parse_cp_range));
	return {T, L, R, D, Greek, Hebrew, Hiragana, Katakana, Han, Virama};
}
function encode_context(enc, {T, L, R, D, Greek, Hebrew, Hiragana, Katakana, Han, Virama}, virama_index) {
	let LD = set_union(L, D);
	let RD = set_union(R, D);
	if (!is_better_member_compression([LD, RD], [L, R, D])) {
		throw new Error('Assumption wrong: LRD');
	}
	let HKH_parts = [Hiragana, Katakana, Han];
	let HKH = set_union(...HKH_parts);
	if (!is_better_member_compression([HKH], HKH_parts)) {
		throw new Error(`Assumption wrong: HKH`);
	}
	if (Number.isInteger(virama_index)) {
		enc.unsigned(virama_index);
	} else {
		enc.write_member(Virama);	
	}
	enc.write_member(T);
	enc.write_member(LD);
	enc.write_member(RD);
	enc.write_member(Greek);
	enc.write_member(Hebrew);
	enc.write_member(HKH);
}

function extract_stops({valid, mapped}) {
	const STOP = 0x2E;
	let stops = new Set([STOP]);
	if (!valid.delete(STOP)) {
		throw new Error(`Assumption wrong: Stop is not valid`);
	}
	for (let [x, ys] of take_from(mapped, ([_, ys]) => ys.includes(STOP))) {
		if (ys.length != 1) {
			throw new Error(`Assumption wrong: ${x} is mapped to a Stop with other characters`);
		}
		stops.add(x);
	}
	return stops;
}

function write_payload(name, enc, hr) {
	let dir = ensure_dir('output');
	// compressed
	let buf = Buffer.from(enc.compress_arithmetic());
	writeFileSync(join(dir, `${name}.js`), `
		import {read_compressed_payload} from '../decoder.js';
		export default read_compressed_payload('${base64(buf)}');
	`);
	// no compression overhead (much larger files)
	writeFileSync(join(dir, `${name}-xcompress.js`), `
		import {read_payload} from '../decoder.js';
		export default read_payload(${JSON.stringify(enc.values)});
	`);
	// raw arithmetic bits
	writeFileSync(join(dir, `${name}.bin`), buf);
	// raw symbols
	writeFileSync(join(dir, `${name}.json`), JSON.stringify(enc.values));
	// human readable
	if (hr) writeFileSync(join(dir, `${name}-hr.json`), JSON.stringify(hr, (_, x) => {
		if (x instanceof Set) {
			return [...x];
		} else {
			return x;
		}
	}));
	// print compressed size
	console.log(`Wrote payload ${name}: ${buf.length} bytes`);
}

function encode_seq(enc, uts51) {
	for (let m of Object.values(uts51.group_seq())) {
		enc.unsigned(m[0].length);
		enc.positive(m.length);
		enc.write_transposed(m.sort(compare_arrays));
	}
	enc.unsigned(0);
}

function encode_zwj(enc, uts51) {
	for (let [key, m] of Object.entries(uts51.group_zwj())) {
		// '1,2,3' => [1,2,3] => [[_],[_,_],[_,_,_]]
		let lens = key.split(',').map(x => parseInt(x));
		for (let x of lens) enc.unsigned(x);
		enc.unsigned(0);
		enc.positive(m.length);
		enc.write_transposed(m.sort(compare_arrays));
	}
	enc.unsigned(0);
}
 
function write_rules_payload(name, {idna, stops, uts51, combining_marks}) {
	if (!stops) {
		// find everything that maps to "."
		stops = extract_stops(idna);
	}
	let allowed = idna.allowed_set();
	if (!combining_marks) {
		// use default combining marks if not specified
		combining_marks = read_combining_marks();
	}
	combining_marks = set_intersect(combining_marks, allowed);

	let enc = new Encoder();
	enc.write_member(stops);
	encode_idna(enc, idna);
	enc.write_member(combining_marks);

	let hr = {
		name,
		idna: {...idna},
		stops,
		combining_marks
	};

	if (uts51) {
		hr.uts51 = {...uts51};

		enc.unsigned(1); // emoji enabled
		enc.write_member(uts51.REGIONAL);
		enc.write_member(uts51.KEYCAP_DROP);
		enc.write_member(uts51.KEYCAP_REQ);
		enc.write_member(uts51.STYLE_DROP);
		enc.write_member(uts51.STYLE_REQ);
		enc.write_member(uts51.STYLE_OPT);
		enc.write_member(uts51.MODIFIER);
		enc.write_member(uts51.MOD_BASE);
		enc.write_member(uts51.TAG_SPEC);

		// whitelisted emoji sequences
		encode_seq(enc, uts51);

		// whitelisted emoji zwj sequences
		// when disabled, uses algorithmic rules
		if (uts51.ZWJS) {
			enc.unsigned(1); // whitelist enabled
			encode_zwj(enc, uts51);
		}

		// experimental
		//enc.write_member(uts51.NON_SOLO); 
	}
	write_payload(`rules-${name}`, enc, hr);
}

function write_release_payload_v1(name, {idna, uts51}) {
	if (uts51.STYLE_OPT.size > 0) throw new Error('optional style not allowed');

	let stops = extract_stops(idna);
	if (stops.size != 1 || !stops.has(0x2E)) throw new Error('invalid stop');
	
	let allowed = idna.allowed_set();
	let combining_marks = set_intersect(read_combining_marks(), allowed);

	let enc = new Encoder();
	encode_idna(enc, idna);
	enc.write_member(combining_marks);

	enc.write_member(uts51.KEYCAP_DROP);
	enc.write_member(uts51.KEYCAP_REQ);
	enc.write_member(uts51.STYLE_DROP);
	enc.write_member(uts51.STYLE_REQ);
	enc.write_member(uts51.MODIFIER);
	enc.write_member(uts51.MOD_BASE);

	encode_seq(enc, uts51);
	encode_zwj(enc, uts51);

	let {virama_index, ...nf} = read_nf_rules();
	encode_nf(enc, nf);

	let context = read_context_rules();
	encode_context(enc, context, virama_index);

	let bidi = read_bidi_rules();
	encode_bidi(enc, bidi);

	write_payload(`release-${name}`, enc, {
		valid: idna.valid,
		mapped: idna.mapped,
		ignored: idna.ignored,
		combining_marks,
		keycap_legacy: uts51.KEYCAP_DROP,
		keycap_required: uts51.KEYCAP_REQ,
		style_legacy: uts51.STYLE_DROP,
		style_required: uts51.STYLE_REQ,
		emoji_modifier: uts51.MODIFIER,
		emoji_modifier_base: uts51.MOD_BASE,
		whitelist_seq: [...uts51.SEQS].map(explode_cp),
		whitelist_zwj: [...uts51.ZWJS].map(explode_cp),
		context,
		bidi,
		normalized_forms: nf
	});
}

function apply_rules(idna, uts51, rules) {
	for (let rule of rules) {
		try {
			let {ty, src, dst} = rule;
			switch (ty) {			
				case 'disable-tags': {
					// remove tags
					uts51.TAG_SPEC.clear();
					break;
				}
				case 'keycap-drop': {
					// proper keycaps are $CAP FE0F 20E3
					// dropped keycaps match this pattern, but strip the FE0F
					// this is supported as a 1-way downgrade
					for (let cp of parse_cp_multi_ranges(src)) {
						if (!uts51.KEYCAP_REQ.delete(cp)) {
							throw new Error(`expected keycap: ${cp}`);
						}
						uts51.KEYCAP_DROP.add(cp);
					}
					continue;
				}
				case 'style-drop': 
				case 'style-opt': 
				case 'style-req': {
					// proper emoji are opt: eg. $EMOJI or $EMOJI FE0F
					// drop matches either pattern, but drops FE0F
					// required only matches FE0F, and keeps the FE0F
					// opt matches either pattern, keeps FE0F if it was provided
					for (let cp of parse_cp_multi_ranges(src)) {
						uts51.set_style(cp, ty);
					}
					continue;
				}
				case 'emoji-zwj': {
					// add a zwj sequence
					let cps = parse_cp_sequence(src);
					uts51.ZWJS.add(String.fromCodePoint(...cps));
					continue;
				}
				case 'emoji-seq': {
					// add an emoji sequence that terminates
					let cps = parse_cp_sequence(src);
					uts51.SEQS.add(String.fromCodePoint(...cps));
					continue;
				}
				case 'demoji': {
					// remove an emoji
					// go thru text processing instead
					let cps = parse_cp_multi_ranges(src);
					if (typeof dst === 'string') {
						// allow for an inline mapping
						if (cps.length != 1) throw new Error('demoji map allows only raw cp');
						idna.remove_rule(cps);
						idna.mapped.push([cps, parse_cp_sequence(dst)]);
					}
					for (let cp of cps) {
						if (!uts51.remove_style(cp)) throw new Error(`demoji not styled`);
						uts51.NON_SOLO.add(cp);
					}
					break;
				}
				case 'ignore': {
					for (let cp of parse_cp_multi_ranges(src)) {
						idna.remove_rule(cp);
						idna.ignored.add(cp);
					}
					continue;
				}
				case 'valid': {
					for (let cp of parse_cp_multi_ranges(src)) {
						idna.remove_rule(cp);
						idna.valid.add(cp);
					}
					continue;
				}
				case 'disallow': {
					for (let cp of parse_cp_multi_ranges(src)) {
						idna.remove_rule(cp);
					}
					continue;
				}
				case 'map': {
					if (dst.includes(' ')) { // MAP x TO ys...
						src = parse_cp(src);
						dst = parse_cp_sequence(dst);
						idna.remove_rule(src);
						idna.mapped.push([src, dst]);
					} else { // map [x,x+1,...] to [y,y+1,...]
						src = parse_cp_range(rule.src);
						dst = parse_cp_range(rule.dst);
						//if (dst.length == 1) dst = Array(src.length).fill(dst[0]); // map to single value
						if (src.length != dst.length) throw new Error(`length`);
						for (let i = 0; i < src.length; i++) {
							let cp = src[i];
							idna.remove_rule(cp);
							idna.mapped.push([cp, [dst[i]]]);
						}
					}
					continue;
				}
				default: throw new Error(`unknown type: ${rule.ty}`);
			}
		} catch (err) {
			console.error(rule);
			throw new Error(`bad rule: ${err.message}`)
		}
	}
	// these emoji must be used with a FE0F
	// so they cannot be handled by text processing
	for (let cp of uts51.STYLE_REQ) {
		idna.remove_rule(cp); // disallows
	}
	idna.check_invariants();
}