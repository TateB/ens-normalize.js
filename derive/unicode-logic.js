import {parse_cp, parse_cp_range, parse_cp_sequence, hex_cp, hex_seq, explode_cp} from './utils.js';
import {readFileSync} from 'node:fs';
import UNPRINTABLES from './unprintables.js';

export function read_valid_regions() {
	return JSON.parse(readFileSync(new URL('./data/regions.json', import.meta.url)));
}

export function read_excluded_scripts() {
	 return JSON.parse(readFileSync(new URL('./data/scripts-excluded.json', import.meta.url)));
}

export function read_limited_scripts() {
	return JSON.parse(readFileSync(new URL('./data/scripts-limited.json', import.meta.url)));
}

export const AUGMENTED_ALL = 'ALL';

// https://www.unicode.org/reports/tr39/#Mixed_Script_Detection
export function augment_script_set(set) {
	if (set.has('Hani')) {
		set.add('Hanb');
		set.add('Jpan');
		set.add('Kore');
	}
	if (set.has('Hira')) set.add('Jpan');
	if (set.has('Kana')) set.add('Jpan');
	if (set.has('Hang')) set.add('Kore');
	if (set.has('Bopo')) set.add('Hanb');
	if (set.has('Zyyy') || set.has('Zinh')) {
		set.clear();
		set.add(AUGMENTED_ALL);
	}
	return set;
}

export function parse_semicolon_file(file, impl = {}) {
	let scope = {
		root: {},
		row([src, cls]) {
			this.get_bucket(cls).push(src);
		},
		...impl,
		get_bucket(key) {
			if (!key) throw new Error(`empty bucket key`);
			let bucket = root[key];
			if (!bucket) bucket = root[key] = [];
			return bucket;
		} 
	};
	let {root, row, comment} = scope;
	for (let line of readFileSync(file, {encoding: 'utf8'}).split('\n')) {
		let rest;
		let pos = line.indexOf('#');
		if (pos >= 0) {
			rest = line.slice(pos + 1).trim();
			line = line.slice(0, pos).trim();
		}
		try {
			if (line) {
				row?.call(scope, line.split(';').map(s => s.trim()), rest);
			} else if (rest) {
				comment?.call(scope, rest);
			}
		} catch (err) {
			console.log(`Error parsing: ${file}`);
			console.log(line);
			throw err;
		}
	}
	return root;
}

export function parse_ucd(dir) {
	// https://www.unicode.org/reports/tr44/#UnicodeData.txt
	// 0000;<control>;Cc;0;BN;;;;;N;NULL;;;;
	// 0031;DIGIT ONE;Nd;0;EN;;1;1;1;N;;;;;
	// 00C0;LATIN CAPITAL LETTER A WITH GRAVE;Lu;0;L;0041 0300;;;;N;LATIN CAPITAL LETTER A GRAVE;;;00E0;
	return parse_semicolon_file(new URL('./UnicodeData.txt', dir), {		
		root: [],
		row(v) {
			if (v.length != 15) throw new Error(`missing columns`);
			let cp = parse_cp(v[0]);
			let info = {
				cp,
				name: v[1],
				old_name: v[10],
				gc: v[2],           // general category
				cc: parseInt(v[3]), // combining class
				bidi_class: v[4], 
				bidi_mirrored: v[9] === 'Y',
				iso_comment: v[11]
			};
			// "" | "<tag>" | "XXXX YYYY" | "<tag>XXXX YYYY"
			let temp = v[5];
			if (temp.startsWith('<')) {
				let pos = temp.indexOf('>');
				if (pos == -1) throw new Error('expected closing bracket');
				info.decomp_type = temp.slice(1, pos);
				temp = temp.slice(pos + 1).trim();
				if (temp) info.decomp = parse_cp_sequence(temp);
			} else if (temp) {
				info.decomp = parse_cp_sequence(temp);
			}
			temp = v[6];
			if (temp) info.dec = parseInt(temp);
			temp = v[7];
			if (temp) info.digit = parseInt(temp);
			temp = v[8];
			if (temp) info.numer = parseInt(temp);
			temp = v[12];
			if (temp) info.upper = parse_cp(temp);
			temp = v[13];
			if (temp) info.lower = parse_cp(temp);
			temp = v[14];
			if (temp) info.title = parse_cp(temp);
			this.root.push(info);
		}
	});
}

export class UnicodeSpec {
	constructor(dir) {
		this.dir = dir;
		this.version = JSON.parse(readFileSync(new URL('./version.json', dir)));
		this.chars = parse_ucd(dir);
		this.char_map = new Map(this.chars.map(x => [x.cp, x]));
		this.cm = new Set(this.general_category('M').map(x => x.cp));
	}
	get version_str() {
		return `${this.version.major}.${this.version.minor}.${this.version.patch}`;
	}
	get_display(cp) {
		let form = !this.char_map.has(cp) || UNPRINTABLES.has(cp) ? '\u{FFFD}' : String.fromCodePoint(cp);		
		if (this.cm.has(cp)) {
			form = '◌' + form; // DOTTED CIRCLE
		}
		return form;
	}	
	get_name(cp) {
		let info = this.char_map.get(cp);
		if (info) {
			let {name, old_name} = info;
			if (name === '<control>' && old_name) {
				name = old_name;
			}
			return name;
		}
	}
	js_format(...a) {		
		// cheap hack
		let s = this.format(...a);
		let i = s.indexOf('(');
		return `0x${s.slice(0, i-1)}, // ${s.slice(i)}`;
	}
	format(x, ...a) {
		let ret;
		if (typeof x === 'number') {
			let form = String.fromCodePoint(x);
			if (this.cm.has(x)) {
				form = '◌' + form; // DOTTED CIRCLE
			}
			ret = `${hex_cp(x)} (${form}) ${this.get_name(x)}`;
		} else if (Array.isArray(x)) {
			ret = x.length === 1 ? this.format(x[0]) : hex_seq(x);
		} else if (typeof x.cp === 'number') {
			ret = `${hex_cp(x.cp)} (${String.fromCodePoint(x.cp)}) ${x.name}`;
		} else {
			ret = `${hex_seq(x.cps) } (${String.fromCodePoint(...x.cps)}) ${x.name}`;
		}
		if (a.length) {
			ret = `${ret} => ${this.format(...a)}`;
		}		
		// 00..19 <control>
		// 7F     DEL
		// 202D   LTR OVERRIDE
		// 202E   RTL OVERRIDE
		return ret.replace(/[\x00-\x19\x7F\u202E\u202D]/gu, '?');
	}
	props() {
		// 0009..000D    ; White_Space # Cc   [5] <control-0009>..<control-000D>
		// 0020          ; White_Space # Zs       SPACE
		return parse_semicolon_file(new URL('./PropList.txt', this.dir), {
			row([src, type]) {
				this.get_bucket(type).push(...parse_cp_range(src));
			}
		});
	}
	core_props() {
		// 002B          ; Math # Sm       PLUS SIGN
		// 003C..003E    ; Math # Sm   [3] LESS-THAN SIGN..GREATER-THAN SIGN
		return parse_semicolon_file(new URL('./DerivedCoreProperties.txt', this.dir), {
			row([src, type]) {
				this.get_bucket(type).push(...parse_cp_range(src));
			}
		});
	}
	prop_values() {
		// AHex; N ; No ; F ; False
		//sc ; Latn ; Latin
		return parse_semicolon_file(new URL('./PropertyValueAliases.txt', this.dir), {
			row([key, ...a]) {
				this.get_bucket(key).push(a);
			}
		});
	}
	scripts() {
		// WARNING: returns full names
		// 0000..001F    ; Common # Cc  [32] <control-0000>..<control-001F>
		// 0020          ; Common # Zs       SPACE
		return Object.entries(parse_semicolon_file(new URL('./Scripts.txt', this.dir), {
			row([src, type]) {
				this.get_bucket(type).push(...parse_cp_range(src));
			}
		}));
	}
	script_extensions() { // abbrs
		// 102E0         ; Arab Copt # Mn       COPTIC EPACT THOUSANDS MARK
		// 102E1..102FB  ; Arab Copt # No  [27] COPTIC EPACT DIGIT ONE..COPTIC EPACT NUMBER NINE HUNDRED
		return parse_semicolon_file(new URL('./ScriptExtensions.txt', this.dir), {
			root: new Map(),
			row([src, abbrs]) {
				let cps = parse_cp_range(src);
				abbrs = abbrs.trim().split(/\s+/);
				for (let cp of cps) {
					this.root.set(cp, abbrs); // not cloned
				}
				/*
				for (let abbr of abbrs.trim().split(/\s+/)) {
					this.get_bucket(abbr).push(...cps);
				}*/
			}
		});
	}
	combining_ranks() {
		// return list of codepoints in order by increasing combining class
		// skips class 0
		let map = new Map();
		for (let info of this.chars) {
			let {cp, cc} = info;
			if (cc > 0) {
				let bucket = map.get(cc);
				if (!bucket) {
					bucket = [];
					map.set(cc, bucket);
				}
				bucket.push(cp);
			}
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
	}
	general_category(prefix) {
		return this.chars.filter(x => x.gc.startsWith(prefix));
	}
	decompositions(compat = false) {
		// "Conversely, the presence of a formatting tag also indicates that the mapping is a compatibility mapping and not a canonical mapping."
		return this.chars.filter(x => x.decomp && (compat || !x.decomp_type)).map(x => [x.cp, x.decomp]);
	}
	composition_exclusions() {
		// 0958    #  DEVANAGARI LETTER QA
		return parse_semicolon_file(new URL('./CompositionExclusions.txt', this.dir), {
			root: [],
			row([src]) {
				this.root.push(parse_cp(src));
			}	
		});
	}
	emoji_zwjs() {
		// 1F468 200D 2764 FE0F 200D 1F468 ; RGI_Emoji_ZWJ_Sequence  ; couple with heart: man, man # E2.0   [1] (👨‍❤️‍👨)	
		return parse_semicolon_file(new URL('./emoji-zwj-sequences.txt', this.dir), {
			row([src, type, name], comment) {
				let cps = parse_cp_sequence(src);
				let version = parse_version_from_comment(comment);
				this.get_bucket(type).push({cps, type, name, version});
			}
		});
	}
	emoji_seqs() {
		//231A..231B    ; Basic_Emoji                  ; watch                              # E0.6   [2] (⌚..⌛)
		//25AB FE0F     ; Basic_Emoji                  ; white small square                 # E0.6   [1] (▫️)
		//0023 FE0F 20E3; Emoji_Keycap_Sequence        ; keycap: \x{23}                     # E0.6   [1] (#️⃣)
		//1F1E6 1F1E8   ; RGI_Emoji_Flag_Sequence      ; flag: Ascension Island             # E2.0   [1] (🇦🇨)
		//1F3F4 E0067 E0062 E0065 E006E E0067 E007F; RGI_Emoji_Tag_Sequence; flag: England  # E5.0   [1] (🏴󠁧󠁢󠁥󠁮󠁧󠁿)
		//261D 1F3FB    ; RGI_Emoji_Modifier_Sequence  ; index pointing up: light skin tone # E1.0   [1] (☝🏻)
		const self = this;
		return parse_semicolon_file(new URL('./emoji-sequences.txt', this.dir), {
			row([src, type, name], comment) {
				let version = parse_version_from_comment(comment);
				if (src.includes('..')) {
					let range = parse_cp_range(src).map(cp => {
						return {cps: [cp], type, name: self.get_name(cp), version};
					});
					// use provide name if possible
					let [first, last] = name.split('..');
					range[0].name = first.trim();
					range[range.length-1].name = last.trim();
					this.get_bucket(type).push(...range);
				} else {
					let cps = parse_cp_sequence(src);
					this.get_bucket(type).push({cps, type, name, version});
				}
			}
		});
	}
	emoji_data() {
		// 0023          ; Emoji                # E0.0   [1] (#️)       hash sign
		// 0030..0039    ; Emoji                # E0.0  [10] (0️..9️)    digit zero..digit nine
		// 261D          ; Emoji_Modifier_Base  # E0.6   [1] (☝️)       index pointing up
		// 0023          ; Emoji_Component      # E0.0   [1] (#️)       hash sign
		// 00A9          ; Extended_Pictographic# E0.6   [1] (©️)       copyright
		const self = this;
		return parse_semicolon_file(new URL('./emoji-data.txt', this.dir), {
			row([src, type], comment) {
				let version = parse_version_from_comment(comment);			
				for (let cp of parse_cp_range(src)) {
					this.get_bucket(type).push({cp, type, name: self.get_name(cp), version});
				}
			}
		});
	}
	emoji_skin_colors() {
		// warning: this sucks
		// 1F3FB..1F3FF  ; Emoji_Component      # E1.0   [5] (🏻..🏿)    light skin tone..dark skin tone
		return this.emoji_data().Emoji_Component.filter(x => /\b(FITZPATRICK)\b/i.test(x.name));
	}
	emoji_hair_colors() {
		// warning: this sucks
		// 1F9B0..1F9B3  ; Emoji_Component      # E11.0  [4] (🦰..🦳)    red hair..white hair
		return this.emoji_data().Emoji_Component.filter(x => /\b(HAIR|BALD)\b/i.test(x.name));
	}
	regional_indicators() {
		return this.props().Regional_Indicator;
	}
	valid_emoji_flag_sequences() {
		let regions = read_valid_regions(); // WARNING: not versioned by spec
		let cps = this.regional_indicators();
		if (cps.length != 26) throw new Error('expected 26 regionals');
		let dx = cps[0] - 0x41; // 'A'
		return regions.map(region => {
			let cps = explode_cp(region).map(x => x + dx);
			let name = `Flag Sequence: ${region}`;
			let type = 'ValidFlagSequence';
			return {cps, name, type};
		});
	}
	idna_rules({version, use_STD3, valid_deviations}) {
		switch (version) {
			case 2003:
			case 2008: break;
			default: throw new TypeError(`unknown IDNA version: ${version}`);
		}
		let {
			valid, valid_NV8, valid_XV8,
			deviation_mapped, deviation_ignored,
			disallowed, disallowed_STD3_mapped, disallowed_STD3_valid,
			ignored, mapped, ...extra
		} = parse_semicolon_file(new URL('./IdnaMappingTable.txt', this.dir), {
			row([src, type, dst, status]) {
				if (!src) throw new Error('wtf src');
				if (type == 'deviation') type = dst ? 'deviation_mapped' : 'deviation_ignored';
				if (status) type = `${type}_${status}`; // NV8/XV8
				let bucket = this.get_bucket(type);
				if (type.includes('mapped')) {
					if (!dst) throw new Error('wtf dst');
					bucket.push([src, dst]);
				} else {
					bucket.push(src); 
				}
			}
		});
		if (Object.keys(extra).length > 0) {
			throw new Error(`unexpected IDNA keys: ${Object.keys(extra)}`);
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
		valid = valid.flatMap(parse_cp_range);
		let valid_set = new Set(valid);
		ignored = ignored.flatMap(parse_cp_range);
		if (ignored.some(cp => valid_set.has(cp))) throw new Error(`Ignored is Valid!`);
		// we need to re-apply the rules to the mapped output
		// x:[char] => ys:[char, char, ...]
		mapped = mapped.flatMap(([src, dst]) => {
			let cps = parse_cp_sequence(dst);
			return cps.every(cp => valid_set.has(cp)) ? parse_cp_range(src).map(x => [x, cps]) : [];
		});
		return {valid, ignored, mapped};
	}
	nf_props() {
		// 037A        ; FC_NFKC                     ; 0020 03B9 # Lm GREEK YPOGEGRAMMENI
		// 11127       ; NFKC_QC                     ; M         # Mn CHAKMA VOWEL SIGN A
		// 1F73        ; Full_Composition_Exclusion              # L& GREEK SMALL LETTER EPSILON WITH OXIA
		// 00C0..00C5  ; Expands_On_NFD                          # L& [6] LATIN CAPITAL LETTER A WITH GRAVE..LATIN CAPITAL LETTER A WITH RING ABOVE
		return parse_semicolon_file(new URL('./DerivedNormalizationProps.txt', this.dir), {
			row([src, type, value]) {
				if (type.endsWith('_QC')) {
					let bucket = this.get_bucket(type);
					for (let cp of parse_cp_range(src)) {
						bucket.push([cp, value]);
					}
				} else if (type.startsWith('FC_')) {
					this.get_bucket(type).push([parse_cp(src), parse_cp_sequence(value)]);
				} else { 
					this.get_bucket(type).push(...parse_cp_range(src));
				}
			}
		});
	}
	nf_tests() {
		return parse_semicolon_file(new URL('./NormalizationTest.txt', this.dir), {
			row([src, nfc, nfd], comment) {
				if (src.startsWith('@')) {
					this.test = this.get_bucket(comment.trim());
				} else {
					let {test} = this;
					if (!test) throw new Error('expected test');
					test.push([src, nfd, nfc].map(s => String.fromCodePoint(...parse_cp_sequence(s))));
				}
			}	
		});
	}
	confusables() {
		// returns entries: [[target, cps], ...]
		// thes are SINGLE CHARCTERS that confuse with a SEQUENCE
		// Each line in the data file has the following format: 
		// - Field 1 is the source, 
		// - Field 2 is the target,
		// - Field 3 is obsolete, always containing the letters “MA” for backwards compatibility. 
		// 06E8 ;	0306 0307 ;	MA	# ( ۨ → ̆̇ ) ARABIC SMALL HIGH NOON → COMBINING BREVE, COMBINING DOT ABOVE
		// 0310 ;	0306 0307 ;	MA	# ( ̐ → ̆̇ ) COMBINING CANDRABINDU → COMBINING BREVE, COMBINING DOT ABOVE
		return Object.entries(parse_semicolon_file(new URL('./confusables.txt', this.dir), {
			row([src, target]) {
				let key = String.fromCodePoint(...parse_cp_sequence(target));
				this.get_bucket(key).push(parse_cp(src));
			}
		})).map(([key, cps]) => [explode_cp(key), cps]);
	}
	intentional_confusables() { 
		// returns list of pairs
		// 0021 ;	01C3	#* ( ! ~ ǃ ) EXCLAMATION MARK ~ LATIN LETTER RETROFLEX CLICK
		return parse_semicolon_file(new URL('./IdentifierStatus.txt', this.dir), {
			root: [],
			row([a, b]) {
				this.root.push([parse_cp(a), parse_cp(b)]);
			}
		});
	}
	allowed_identifiers() { 
		// returns list of codepoints
		// 002D..002E ; Allowed    # 1.1    [2] HYPHEN-MINUS..FULL STOP
		return parse_semicolon_file(new URL('./IdentifierStatus.txt', this.dir), {
			root: [],
			row([src]) {
				this.root.push(...parse_cp_range(src));
			}
		});
	}
	identifier_types() { 
		// returns map of name => codepoints
		return parse_semicolon_file(new URL('./IdentifierType.txt', this.dir), {
			row([src, type]) {
				this.get_bucket(type).push(...parse_cp_range(src));
			}
		});
	}
}

function parse_version_from_comment(s) {
	let match = s.match(/^E(\d+.\d+)\b/);
	if (!match) throw new Error(`expected version: ${s}`);
	return match[1];
}

export class UnicodeScripts {
	constructor(spec) {
		this.spec = spec;
		let {sc} = spec.prop_values(); // sc = Script
		// this.names = new Map(sc.map(v => [v[0], v[1]])); // abbr -> name
		let name2abbr = new Map(sc.map(v => [v[1], v[0]])); // name -> abbr
		// work in abbrs
		this.entries = spec.scripts().map(([name, cps]) => {
			let abbr = name2abbr.get(name);
			if (!abbr) throw new TypeError(`unknown script abbr: ${name}`);
			name = name.replaceAll('_', ' '); // fix name
			return {name, abbr, set: new Set(cps)};
		});
		this.by_abbr = Object.fromEntries(this.entries.map(x => [x.abbr, x])); // use Object so we can $.Latn
		// load extensions
		this.exts = spec.script_extensions();
	}
	require(abbr) {		
		let script = this.by_abbr[abbr];
		if (!script) throw new TypeError(`expected script abbr: ${abbr}`);
		return script;
	}
	excluded() { 
		return read_excluded_scripts(); 
	}
	limited() { 
		return read_limited_scripts(); 
	}
	get_details(cp) {
		let script = this.get_script(cp);
		let aug = this.get_extended_script_set(cp);
		let ret = script?.abbr ?? 'Unknown';
		if (script ? aug.size == 1 && aug.has(script.abbr) : aug.size == 0) {
			// same, not aug
		} else {
			ret = `${ret} => ${[...aug].join(',')}`;
		}
		return `${this.spec.get_name(cp)} [${ret}]`;
	}
	get_script(cp) {		
		return this.entries.find(x => x.set.has(cp));
	}
	get_script_set(x) {
		let ret = new Set();
		for (let cp of explode_cp(x)) {
			let script = this.get_script(cp);
			if (script) {
				ret.add(script.abbr);
			}
		}
		return ret;
	}
	get_extended_script_set(x) {
		let ret = new Set();
		for (let cp of explode_cp(x)) {
			let ext = this.exts.get(cp);
			if (ext) {
				for (let abbr of ext) {
					ret.add(abbr);
				}
			} else {
				let script = this.get_script(cp);
				if (script) {
					ret.add(script.abbr);
				}
			}
		}
		return ret;
	}
	get_augmented_script_set(x) {
		return augment_script_set(this.get_extended_script_set(x));
	}
	get_resolved_script_set(x) {
		// https://www.unicode.org/reports/tr39/#def-resolved-script-set
		let cps = explode_cp(x);
		if (!cps.length) return new Set();
		let resolved = this.get_augmented_script_set(cps[0]);
		for (let i = 1; i < cps.length; i++) {
			let set = this.get_resolved_script_set(cps[i]);
			if (set.has(AUGMENTED_ALL)) continue;
			if (resolved.has(AUGMENTED_ALL)) {
				resolved = set;
			} else {
				for (let abbr of set) {
					if (!resolved.has(abbr)) {
						resolved.delete(abbr);
					}
				}
				for (let abbr of resolved) {
					if (!set.has(abbr)) {
						resolved.delete(abbr);
					}
				}

			}
		}
		return resolved;
	}
	apply_changes(map) { // abbr => [cp, ...]
		for (let [abbr, cps] of Object.entries(map)) {
			let dst = this.require(abbr);
			for (let cp of cps) {
				let src = this.get_script(cp);
				if (!src) throw new Error(`Expected script: ${this.spec.format(cp)}`);
				src.set.delete(cp);
				dst.set.add(cp);
				console.log(`Changed Script [${src.abbr} => ${dst.abbr}]: ${this.spec.format(cp)}`);
			}
		}
	}
}

export class UnicodePrinter {
	constructor(scripts) {
		this.scripts = scripts;
	}
	js_char(cp) {
		return `0x${hex_cp(cp)}, // (${this.scripts.spec.get_display(cp)}) ${this.scripts.spec.get_name(cp)}`;
	}
	js(x) {
		if (Number.isInteger(x)) {
			return this.js_char(x);
		} else {
			throw new TypeError('NYI');
		}
	}
}

