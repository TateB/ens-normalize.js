function decode_arithmetic(bytes) {
	let pos = 0;
	function u16() { return (bytes[pos++] << 8) | bytes[pos++]; }
	
	// decode the frequency table
	let symbol_count = u16();
	let total = 1;
	let acc = [0, 1]; // first symbol has frequency 1
	for (let i = 1; i < symbol_count; i++) {
		acc.push(total += u16());
	}

	// skip the sized-payload that the last 3 symbols index into
	let skip = u16();
	let pos_payload = pos;
	pos += skip;

	let read_width = 0;
	let read_buffer = 0; 
	function read_bit() {
		if (read_width == 0) {
			// this will read beyond end of buffer
			// but (undefined|0) => zero pad
			read_buffer = (read_buffer << 8) | bytes[pos++];
			read_width = 8;
		}
		return (read_buffer >> --read_width) & 1;
	}

	const N = 31;
	const FULL = 2**N;
	const HALF = FULL >>> 1;
	const QRTR = HALF >> 1;
	const MASK = FULL - 1;

	// fill register
	let register = 0;
	for (let i = 0; i < N; i++) register = (register << 1) | read_bit();

	let symbols = [];
	let low = 0;
	let range = FULL; // treat like a float
	while (true) {
		let value = Math.floor((((register - low + 1) * total) - 1) / range);
		let start = 0;
		let end = symbol_count;
		while (end - start > 1) { // binary search
			let mid = (start + end) >>> 1;
			if (value < acc[mid]) {
				end = mid;
			} else {
				start = mid;
			}
		}
		if (start == 0) break; // first symbol is end mark
		symbols.push(start);
		let a = low + Math.floor(range * acc[start]   / total);
		let b = low + Math.floor(range * acc[start+1] / total) - 1;
		while (((a ^ b) & HALF) == 0) {
			register = (register << 1) & MASK | read_bit();
			a = (a << 1) & MASK;
			b = (b << 1) & MASK | 1;
		}
		while (a & ~b & QRTR) {
			register = (register & HALF) | ((register << 1) & (MASK >>> 1)) | read_bit();
			a = (a << 1) ^ HALF;
			b = ((b ^ HALF) << 1) | HALF | 1;
		}
		low = a;
		range = 1 + b - a;
	}
	let offset = symbol_count - 4;
	return symbols.map(x => { // index into payload
		switch (x - offset) {
			case 3: return offset + 0x10100 + ((bytes[pos_payload++] << 16) | (bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 2: return offset + 0x100 + ((bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 1: return offset + bytes[pos_payload++];
			default: return x - 1;
		}
	});
}	

// returns an iterator which returns the next symbol
function read_payload(v) {
	let pos = 0;
	return () => v[pos++];
}
function read_compressed_payload(s) {	
	return read_payload(decode_arithmetic(unsafe_atob(s)));
}

// unsafe in the sense:
// expected well-formed Base64 w/o padding 
function unsafe_atob(s) {
	let lookup = [];
	[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((c, i) => lookup[c.charCodeAt(0)] = i);
	let n = s.length;
	let ret = new Uint8Array((6 * n) >> 3);
	for (let i = 0, pos = 0, width = 0, carry = 0; i < n; i++) {
		carry = (carry << 6) | lookup[s.charCodeAt(i)];
		width += 6;
		if (width >= 8) {
			ret[pos++] = (carry >> (width -= 8));
		}
	}
	return ret;
}

// eg. [0,1,2,3...] => [0,-1,1,-2,...]
function signed(i) { 
	return (i & 1) ? (~i >> 1) : (i >> 1);
}

function read_counts(n, next) {
	let v = Array(n);
	for (let i = 0; i < n; i++) v[i] = 1 + next();
	return v;
}

function read_ascending(n, next) {
	let v = Array(n);
	for (let i = 0, x = -1; i < n; i++) v[i] = x += 1 + next();
	return v;
}

function read_deltas(n, next) {
	let v = Array(n);
	for (let i = 0, x = 0; i < n; i++) v[i] = x += signed(next());
	return v;
}

// return unsorted? unique array 
function read_member_array(next, lookup) {
	let v = read_ascending(next(), next);
	let n = next();
	let vX = read_ascending(n, next);
	let vN = read_counts(n, next);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < vN[i]; j++) {
			v.push(vX[i] + j);
		}
	}
	return lookup ? v.map(x => lookup[x]) : v;
}

// returns map of x => ys
function read_mapped(next) {
	let ret = [];
	while (true) {
		let w = next();
		if (w == 0) break;
		ret.push(read_linear_table(w, next));
	}
	while (true) {
		let w = next() - 1;
		if (w < 0) break;
		ret.push(read_replacement_table(w, next));
	}
	return ret.flat();
}

// read until next is falsy
// return array of read values
function read_array_while(next) {
	let v = [];
	while (true) {
		let x = next();
		if (!x) break;
		v.push(x);
	}
	return v;
}

// read w columns of length n
// return as n rows of length w
function read_transposed(n, w, next) {
	let m = Array(n).fill().map(() => []);
	for (let i = 0; i < w; i++) {
		read_deltas(n, next).forEach((x, j) => m[j].push(x));
	}
	return m;
}
 
// returns [[x, ys], [x+dx, ys+dy], [x+2*dx, ys+2*dy], ...]
// where dx/dy = steps, n = run size, w = length of y
function read_linear_table(w, next) {
	let dx = 1 + next();
	let dy = next();
	let vN = read_array_while(next);
	let m = read_transposed(vN.length, 1+w, next);
	return m.flatMap((v, i) => {
		let [x, ...ys] = v;
		return Array(vN[i]).fill().map((_, j) => {
			let j_dy = j * dy;
			return [x + j * dx, ys.map(y => y + j_dy)];
		});
	});
}

// return [[x, ys...], ...]
// where w = length of y
function read_replacement_table(w, next) { 
	let n = 1 + next();
	let m = read_transposed(n, 1+w, next);
	return m.map(v => [v[0], v.slice(1)]);
}

function read_emoji_trie(next) {
	let sorted = read_member_array(next).sort((a, b) => a - b);
	return read();
	function read() {
		let branches = [];
		while (true) {
			let keys = read_member_array(next, sorted);
			if (keys.length == 0) break;
			branches.push({set: new Set(keys), node: read()});
		}
		branches.sort((a, b) => b.set.size - a.set.size); // sort by likelihood
		let temp = next();
		let valid = temp % 3;
		temp = (temp / 3)|0;
		let fe0f = !!(temp & 1);
		temp >>= 1;
		let save = temp == 1;
		let check = temp == 2;
		return {branches, valid, fe0f, save, check};
	}
}

// created 2022-10-05T07:53:29.301Z
var r$1 = read_compressed_payload('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');

function hex_cp(cp) {
	return cp.toString(16).toUpperCase().padStart(2, '0');
}

/*
export function explode_cp(s) {
	return [...s].map(c => c.codePointAt(0));
}
*/
function explode_cp(s) { // this is about 2x faster
	let cps = [];
	for (let pos = 0, len = s.length; pos < len; ) {
		let cp = s.codePointAt(pos);
		pos += cp < 0x10000 ? 1 : 2;
		cps.push(cp);
	}
	return cps;
}

function str_from_cps(cps) {
	return String.fromCodePoint(...cps);
}

// created 2022-10-05T07:53:29.370Z
var r = read_compressed_payload('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');

// https://unicode.org/reports/tr15/

function unpack_cc(packed) {
	return (packed >> 24) & 0xFF;
}
function unpack_cp(packed) {
	return packed & 0xFFFFFF;
}

const SHIFTED_RANK = new Map(read_array_while(() => {
	let v = read_member_array(r);
	if (v.length) return v;
}).flatMap((v, i) => v.map(x => [x, (i+1) << 24]))); // pre-shifted

const EXCLUSIONS = new Set(read_member_array(r));
const DECOMP = new Map();
const RECOMP = new Map();
for (let [cp, cps] of read_mapped(r)) {
	if (!EXCLUSIONS.has(cp) && cps.length == 2) {
		let [a, b] = cps;
		let bucket = RECOMP.get(a);
		if (!bucket) {
			bucket = new Map();
			RECOMP.set(a, bucket);
		}
		bucket.set(b, cp);
	}
	DECOMP.set(cp, cps.reverse()); // stored reversed
}

// algorithmic hangul
// https://www.unicode.org/versions/Unicode15.0.0/ch03.pdf (page 144)
const S0 = 0xAC00;
const L0 = 0x1100;
const V0 = 0x1161;
const T0 = 0x11A7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;
const S1 = S0 + S_COUNT;
const L1 = L0 + L_COUNT;
const V1 = V0 + V_COUNT;
const T1 = T0 + T_COUNT;

function is_hangul(cp) {
	return cp >= S0 && cp < S1;
}

function compose_pair(a, b) {
	if (a >= L0 && a < L1 && b >= V0 && b < V1) {
		return S0 + (a - L0) * N_COUNT + (b - V0) * T_COUNT;
	} else if (is_hangul(a) && b > T0 && b < T1 && (a - S0) % T_COUNT == 0) {
		return a + (b - T0);
	} else {
		let recomp = RECOMP.get(a);
		if (recomp) {
			recomp = recomp.get(b);
			if (recomp) {
				return recomp;
			}
		}
		return -1;
	}
}

function decomposed(cps) {
	let ret = [];
	let buf = [];
	let check_order = false;
	function add(cp) {
		let cc = SHIFTED_RANK.get(cp);
		if (cc) {
			check_order = true;
			cp |= cc;
		}
		ret.push(cp);
	}
	for (let cp of cps) {
		while (true) {
			if (cp < 0x80) {
				ret.push(cp);
			} else if (is_hangul(cp)) {
				let s_index = cp - S0;
				let l_index = s_index / N_COUNT | 0;
				let v_index = (s_index % N_COUNT) / T_COUNT | 0;
				let t_index = s_index % T_COUNT;
				add(L0 + l_index);
				add(V0 + v_index);
				if (t_index > 0) add(T0 + t_index);
			} else {
				let mapped = DECOMP.get(cp);
				if (mapped) {
					buf.push(...mapped);
				} else {
					add(cp);
				}
			}
			if (!buf.length) break;
			cp = buf.pop();
		}
	}
	if (check_order && ret.length > 1) {
		let prev_cc = unpack_cc(ret[0]);
		for (let i = 1; i < ret.length; i++) {
			let cc = unpack_cc(ret[i]);
			if (cc == 0 || prev_cc <= cc) {
				prev_cc = cc;
				continue;
			}
			let j = i-1;
			while (true) {
				let tmp = ret[j+1];
				ret[j+1] = ret[j];
				ret[j] = tmp;
				if (!j) break;
				prev_cc = unpack_cc(ret[--j]);
				if (prev_cc <= cc) break;
			}
			prev_cc = unpack_cc(ret[i]);
		}
	}
	return ret;
}

function composed_from_decomposed(v) {
	let ret = [];
	let stack = [];
	let prev_cp = -1;
	let prev_cc = 0;
	for (let packed of v) {
		let cc = unpack_cc(packed);
		let cp = unpack_cp(packed);
		if (prev_cp == -1) {
			if (cc == 0) {
				prev_cp = cp;
			} else {
				ret.push(cp);
			}
		} else if (prev_cc > 0 && prev_cc >= cc) {
			if (cc == 0) {
				ret.push(prev_cp, ...stack);
				stack.length = 0;
				prev_cp = cp;
			} else {
				stack.push(cp);
			}
			prev_cc = cc;
		} else {
			let composed = compose_pair(prev_cp, cp);
			if (composed >= 0) {
				prev_cp = composed;
			} else if (prev_cc == 0 && cc == 0) {
				ret.push(prev_cp);
				prev_cp = cp;
			} else {
				stack.push(cp);
				prev_cc = cc;
			}
		}
	}
	if (prev_cp >= 0) {
		ret.push(prev_cp, ...stack);	
	}
	return ret;
}

function nfd(cps) {
	return decomposed(cps).map(unpack_cp);
}

function nfc(cps) {
	return composed_from_decomposed(decomposed(cps));
}

const SORTED_VALID = read_member_array(r$1).sort((a, b) => a - b);
const VALID = new Set(SORTED_VALID);
const IGNORED = new Set(read_member_array(r$1));
const MAPPED = new Map(read_mapped(r$1));
function read_valid_subset() {
	return new Set(read_member_array(r$1, SORTED_VALID));
}
const CM = read_valid_subset();
const ISOLATED = read_valid_subset();
const SCRIPTS = ['Latin', 'Greek', 'Cyrillic'].map((k, i) => {
	// this defines the priority
	// order must match make.js
	// note: there are no latin (index = 0) whole-script confusables
	// (script name, script-set, whole-set?)
	return [k, read_valid_subset(), i ? read_valid_subset() : 0]; 
});
const EXCLUDED = read_array_while(() => {
	let v = read_valid_subset();
	if (v.size) return v;
});
const EMOJI_SOLO = new Set(read_member_array(r$1));
const EMOJI_ROOT = read_emoji_trie(r$1);
const NFC_CHECK = read_valid_subset();

const STOP = 0x2E;
const HYPHEN = 0x2D;
const UNDERSCORE = 0x5F;
const FE0F = 0xFE0F;

function check_leading_underscore(cps) {
	let i = cps.lastIndexOf(UNDERSCORE);
	while (i > 0) {
		if (cps[--i] !== UNDERSCORE) {
			throw new Error(`underscore only allowed at start`);
		}
	}
}

function check_label_extension(cps) {
	if (cps.length >= 4 && cps[2] === HYPHEN && cps[3] === HYPHEN && cps.every(cp => cp < 0x80)) {
		throw new Error(`invalid label extension`);
	}
}

// check that cp is not touching another cp
// optionally disallow leading/trailing
function check_surrounding(cps, cp, name, no_leading, no_trailing) {
	let last = -1;
	if (cps[0] === cp) {
		if (no_leading) throw new Error(`leading ${name}`);
		last = 0;
	}
	while (true) {
		let i = cps.indexOf(cp, last+1);
		if (i == -1) break;
		if (last == i-1) throw new Error(`adjacent ${name}`);
		last = i;
	}
	if (no_trailing && last == cps.length-1) throw new Error(`trailing ${name}`);
}

// ContextO: MIDDLE DOT
// https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.3
// Between 'l' (U+006C) characters only, used to permit the Catalan character ela geminada to be expressed.
function check_middle_dot(cps) {
	let i = 0;
	while (true) {
		i = cps.indexOf(0xB7, i);
		if (i == -1) break;
		if (cps[i-1] !== 0x6C || cps[i+1] !== 0x6C) throw new Error('ContextO: middle dot');
		i += 2;
	}
}

function check_scripts_latin_like(cps) {
	// https://www.unicode.org/reports/tr39/#mixed_script_confusables
	for (let i = 0; i < SCRIPTS.length; i++) {
		let [name, script_set, whole_set] = SCRIPTS[i];
		if (cps.some(cp => script_set.has(cp))) {
			for (let j = i + 1; j < SCRIPTS.length; j++) { // scripts before already had no match
				let [name_j, set_j] = SCRIPTS[j];
				if (cps.some(cp => set_j.has(cp))) {
					throw new Error(`mixed-script confusable: ${name} + ${name_j}`);
				}
			}
			if (whole_set) { // aka non-latin
				// https://www.unicode.org/reports/tr39/#def_whole_script_confusables
				// if every char matching the script is confusable
				if (cps.every(cp => !script_set.has(cp) || whole_set.has(cp))) {
					throw new Error(`whole-script confusable: ${name}`);
				}
			}
			break;
		}
	}
}

// requires decomposed codepoints
function check_excluded_scripts(cps) {
	// https://www.unicode.org/reports/tr31/#Table_Candidate_Characters_for_Exclusion_from_Identifiers
	for (let set of EXCLUDED) {
		if (cps.some(cp => set.has(cp))) { // first with one match
			if (!cps.every(cp => set.has(cp) || cp == FE0F)) { // must match all (or emoji)
				throw new Error(`excluded script cannot mix`);
			}
			break; // pure
		}
	}
}

// requires decomposed codepoints
function check_combinining_marks(cps) {
	for (let i = 0, j = -1; i < cps.length; i++) {
		if (CM.has(cps[i])) {
			if (i == 0) {
				throw new Error(`leading combining mark`);
			} else if (i == j) {
				throw new Error(`adjacent combining marks "${str_from_cps(cps.slice(i - 2, i + 1))}"`);
			} else {
				let prev = cps[i - 1];
				if (prev == FE0F || ISOLATED.has(prev)) {
					throw new Error(`isolate combining mark`);
				}
			}	
			j = i + 1;
		}
	}
}

// this function only makes sense if the input 
// was an output of ens_normalize_fragment 
function ens_normalize_post_check(norm) {
	for (let label of norm.split('.')) {
		if (!label) throw new Error('Empty label');
		try {
			let cps_nfc = explode_cp(label);
			check_leading_underscore(cps_nfc);
			check_label_extension(cps_nfc);
			check_surrounding(cps_nfc, 0x2019, 'apostrophe', true, true); // question: can this be generalized better?
			check_middle_dot(cps_nfc); // this a lot of effort for 1 character
			check_scripts_latin_like(cps_nfc);
			// replace emoji with single character
			let cps_nfd = nfd(process(label, () => [FE0F])); 
			check_combinining_marks(cps_nfd);
			check_excluded_scripts(cps_nfd); // idea: it's probably safe to early terminate if this is pure
		} catch (err) {
			throw new Error(`Invalid label "${label}": ${err.message}`); // note: label might not exist in the input string
		}
	}
	return norm;
}

function ens_normalize_fragment(frag, nf = nfc) {
	return str_from_cps(nf(process(frag, filter_fe0f)));
}

function ens_normalize(name) {
	return ens_normalize_post_check(ens_normalize_fragment(name));
}

// note: does not post_check
function ens_beautify(name) {
	return str_from_cps(nfc(process(name, x => x)));
}

function filter_fe0f(cps) {
	return cps.filter(cp => cp != FE0F);
}

function process(name, emoji_filter) {
	let input = explode_cp(name).reverse(); // flip so we can pop
	let output = [];
	while (input.length) {
		let emoji = consume_emoji_reversed(input);
		if (emoji) {
			output.push(...emoji_filter(emoji)); // idea: emoji_filter(emoji, output.length); // provide position to callback
		} else {
			let cp = input.pop();
			if (VALID.has(cp)) {
				output.push(cp);
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					output.push(...cps);
				} else if (!IGNORED.has(cp)) {
					throw new Error(`Disallowed codepoint: 0x${hex_cp(cp)}`);
				}
			}
		}
	}
	return output;
}

function consume_emoji_reversed(cps, eaten) {
	let node = EMOJI_ROOT;
	let emoji;
	let saved;
	let stack = [];
	let pos = cps.length;
	if (eaten) eaten.length = 0; // clear input buffer (if needed)
	while (pos) {
		let cp = cps[--pos];
		let br = node.branches.find(x => x.set.has(cp));
		if (!br) break;
		node = br.node;
		if (node.save) { // remember
			saved = cp;
		} else if (node.check) { // check exclusion
			if (cp === saved) break;
		}
		stack.push(cp);
		if (node.fe0f) {
			stack.push(FE0F);
			if (pos > 0 && cps[pos - 1] == FE0F) pos--; // consume optional FE0F
		}
		if (node.valid) { // this is a valid emoji (so far)
			emoji = conform_emoji_copy(stack, node);
			if (eaten) eaten.push(...cps.slice(pos).reverse()); // copy input (if needed)
			cps.length = pos; // truncate
		}
	}
	if (!emoji) {
		let cp = cps[cps.length-1];
		if (EMOJI_SOLO.has(cp)) {
			if (eaten) eaten.push(cp);
			emoji = [cp];
			cps.pop();
		}
	}
	return emoji;
}

// create a copy and fix any unicode quirks
function conform_emoji_copy(cps, node) {
	let copy = cps.slice(); // copy stack
	if (node.valid == 2) copy.splice(1, 1); // delete FE0F at position 1 (see: make.js)
	return copy;
}

// return all supported emoji (not sorted)
function ens_emoji() {
	let ret = [...EMOJI_SOLO].map(x => [x]);
	build(EMOJI_ROOT, []);
	return ret;
	function build(node, cps, saved) {
		if (node.save) { // remember
			saved = cps[cps.length-1];
		} else if (node.check) { // check exclusion
			if (saved === cps[cps.length-1]) return;
		}
		if (node.fe0f) cps.push(FE0F);
		if (node.valid) ret.push(conform_emoji_copy(cps, node));
		for (let br of node.branches) {
			for (let cp of br.set) {
				build(br.node, [...cps, cp], saved);
			}
		}
	}
}

// ************************************************************
// tokenizer 

const TY_VALID = 'valid';
const TY_MAPPED = 'mapped';
const TY_IGNORED = 'ignored';
const TY_DISALLOWED = 'disallowed';
const TY_EMOJI = 'emoji';
const TY_ISOLATED = 'isolated';
const TY_NFC = 'nfc';
const TY_STOP = 'stop';

function ens_tokenize(name) {
	let input = explode_cp(name).reverse();
	let eaten = [];
	let tokens = [];
	while (input.length) {		
		let emoji = consume_emoji_reversed(input, eaten);
		if (emoji) {
			tokens.push({type: TY_EMOJI, emoji, input: eaten.slice(), cps: filter_fe0f(emoji)});
		} else {
			let cp = input.pop();
			if (cp === STOP) {
				tokens.push({type: TY_STOP});
			} else if (VALID.has(cp)) {
				if (ISOLATED.has(cp)) {
					tokens.push({type: TY_ISOLATED, cp});
				} else {
					tokens.push({type: TY_VALID, cps: [cp]});
				}
			} else if (IGNORED.has(cp)) {
				tokens.push({type: TY_IGNORED, cp});
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					tokens.push({type: TY_MAPPED, cp, cps: cps.slice()});
				} else {
					tokens.push({type: TY_DISALLOWED, cp});
				}
			}
		}
	}
	for (let i = 0, start = -1; i < tokens.length; i++) {
		let token = tokens[i];
		if (is_valid_or_mapped(token.type)) {
			if (requires_check(token.cps)) { // normalization might be needed
				let end = i + 1;
				for (let pos = end; pos < tokens.length; pos++) { // find adjacent text
					let {type, cps} = tokens[pos];
					if (is_valid_or_mapped(type)) {
						if (!requires_check(cps)) break;
						end = pos + 1;
					} else if (type !== TY_IGNORED) { // || type !== TY_DISALLOWED) { 
						break;
					}
				}
				if (start < 0) start = i;
				let slice = tokens.slice(start, end);
				let cps0 = slice.flatMap(x => is_valid_or_mapped(x.type) ? x.cps : []); // strip junk tokens
				let cps = nfc(cps0); // this does extra work for nf-native but oh well
				//if (cps0.length === cps.length && cps0.every((cp, i) => cp === cps[i])) { 
				if (str_from_cps(cps0) === str_from_cps(cps)) {
					i = end - 1; // skip to end of slice
				} else { // bundle into an nfc token
					tokens.splice(start, end - start, {type: TY_NFC, input: cps0, cps, tokens: collapse_valid_tokens(slice)});
					i = start;
				}
				start = -1; // reset
			} else {
				start = i; // remember last
			}
		} else if (token.type === TY_EMOJI) {
			start = -1; // reset
		}
	}
	return collapse_valid_tokens(tokens);
}

function is_valid_or_mapped(type) {
	return type === TY_VALID || type === TY_MAPPED;
}

function requires_check(cps) {
	return cps.some(cp => NFC_CHECK.has(cp));
}

function collapse_valid_tokens(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type === TY_VALID) {
			let j = i + 1;
			while (j < tokens.length && tokens[j].type === TY_VALID) j++;
			tokens.splice(i, j - i, {type: TY_VALID, cps: tokens.slice(i, j).flatMap(x => x.cps)});
		}
	}
	return tokens;
}

export { ens_beautify, ens_emoji, ens_normalize, ens_normalize_fragment, ens_normalize_post_check, ens_tokenize, nfc, nfd };
