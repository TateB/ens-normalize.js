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
function read_compressed_payload(bytes) {
	return read_payload(decode_arithmetic(bytes));
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

// returns array of 
// [x, ys] => single replacement rule
// [x, ys, n, dx, dx] => linear map
function read_mapped_map(next) {
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
	return Object.fromEntries(ret.flat());
}

function read_zero_terminated_array(next) {
	let v = [];
	while (true) {
		let i = next();
		if (i == 0) break;
		v.push(i);
	}
	return v;
}

function read_transposed(n, w, next, lookup) {
	let m = Array(n).fill().map(() => []);
	for (let i = 0; i < w; i++) {
		read_deltas(n, next).forEach((x, j) => m[j].push(lookup ? lookup(x) : x));
	}
	return m;
}
 
function read_linear_table(w, next) {
	let dx = 1 + next();
	let dy = next();
	let vN = read_zero_terminated_array(next);
	let m = read_transposed(vN.length, 1+w, next);
	return m.flatMap((v, i) => {
		let [x, ...ys] = v;
		return Array(vN[i]).fill().map((_, j) => {
			let j_dy = j * dy;
			return [x + j * dx, ys.map(y => y + j_dy)];
		});
	});
}

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
			let keys = read_member_array(next);
			if (keys.length == 0) break;
			branches.push({set: new Set(keys.map(i => sorted[i])), node: read()});
		}
		branches.sort((a, b) => b.set.size - a.set.size);
		let flag = next();
		return {
			branches,
			valid: (flag & 1) != 0, 
			fe0f: (flag & 2) != 0, 
			save: (flag & 4) != 0, 
			check: (flag & 8) != 0,
		};
	}
}

var r = read_compressed_payload(Uint8Array.from(atob('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'), c => c.charCodeAt(0)));

const VALID = new Set(read_member_array(r));
const IGNORED = new Set(read_member_array(r));
const MAPPED = read_mapped_map(r);
const EMOJI_ROOT = read_emoji_trie(r);
const NFC_CHECK = new Set(read_member_array(r, [...VALID].sort((a, b) => a - b)));

function nfc(s) {
	return s.normalize('NFC');
}

function explode_cp(s) {
	return [...s].map(x => x.codePointAt(0));
}

function filter_fe0f(cps) {
	return cps.filter(cp => cp != 0xFE0F);
}

function ens_normalize(name, beautify = false) {
	let input = [...name].map(x => x.codePointAt(0)).reverse(); // flip for pop
	let output = [];
	while (input.length) {		
		let emoji = consume_emoji_reversed(input, EMOJI_ROOT);
		if (emoji) {
			output.push(...(beautify ? emoji.emoji : filter_fe0f(emoji.input)));
			continue;
		}
		let cp = input.pop();
		if (VALID.has(cp)) {
			output.push(cp);
			continue;
		} 
		if (IGNORED.has(cp)) {
			continue;
		}
		let cps = MAPPED[cp];
		if (cps) {
			output.push(...cps);
			continue;
		}
		throw new Error(`Disallowed codepoint: 0x${cp.toString(16).toUpperCase()}`);
	}
	return nfc(String.fromCodePoint(...output));
}

const TY_VALID = 'valid';
const TY_MAPPED = 'mapped';
const TY_IGNORED = 'ignored';

function ens_tokenize(name) {
	let input = explode_cp(name).reverse();
	let tokens = [];
	while (input.length) {		
		let emoji = consume_emoji_reversed(input, EMOJI_ROOT);
		if (emoji) {
			tokens.push({type: 'emoji', ...emoji, cps: filter_fe0f(emoji.input)});
		} else {
			let cp = input.pop();
			if (cp === 0x2E) {
				tokens.push({type: 'stop'});
			} else if (VALID.has(cp)) {
				tokens.push({type: TY_VALID, cps: [cp]});
			} else if (IGNORED.has(cp)) {
				tokens.push({type: TY_IGNORED, cp});
			} else {
				let cps = MAPPED[cp];
				if (cps) {
					tokens.push({type: TY_MAPPED, cp, cps});
				} else {
					tokens.push({type: 'disallowed', cp});
				}
			}
		}
	}
	for (let i = 0, last = 0; i < tokens.length; i++) {
		if (nfc_check_token(tokens[i])) {
			let end = i + 1;
			while (end < tokens.length && nfc_check_token(tokens[end], true)) end++;
			let slice = tokens.slice(last, end);
			let cps = slice.flatMap(x => x.cps ?? []);
			let str0 = String.fromCodePoint(...cps);
			let str = nfc(str0);
			if (str0 === str) {
				last = end;
				i = end - 1; // skip
			} else {
				tokens.splice(last, end - last, {type: 'nfc', input: cps, cps: explode_cp(str), tokens: collapse_valid_tokens(slice)});
				i = last++;
			}
		} else {
			switch (tokens[i].type) {
				case TY_VALID: 
				case TY_MAPPED: last = i; break;
			}
		}
	}
	return collapse_valid_tokens(tokens);
}

function nfc_check_token(token, ignored) {
	switch (token.type) {
		case TY_VALID:
		case TY_MAPPED: return token.cps.some(cp => NFC_CHECK.has(cp));
		case TY_IGNORED: return ignored;
	}
}

// collapse adjacent valid tokens
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

function consume_emoji_reversed(cps, node) {
	let emoji;
	let fe0f;
	let stack = [];
	let input = [];
	let pos = cps.length;
	while (pos) {
		let cp = cps[--pos];
		if (cp === 0xFE0F) {
			if (!fe0f) break; // we didn't expect FE0F
			fe0f = false; // clear flag
			continue;
		}
		node = node.branches.find(x => x.set.has(cp))?.node;
		if (!node) break;
		stack.push(cp);
		fe0f = node.fe0f;
		if (fe0f) stack.push(0xFE0F);
		if (node.valid) { // this is a valid emoji (so far)
			if (fe0f && pos > 0 && cps[pos - 1] == 0xFE0F) { // eat FE0F too
				fe0f = false;
				pos--;
			}
			emoji = stack.slice(); // copy stack
			input.push(...cps.slice(pos).reverse()); // copy input
			cps.length = pos; // truncate
		}
	}
	if (emoji) return {input, emoji};
}

export { ens_normalize, ens_tokenize };