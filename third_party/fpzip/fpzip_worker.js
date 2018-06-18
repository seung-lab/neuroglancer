importScripts('./fpzip.js');

let fpzip_struct_decoded_image = {
	type: 'i32',
	prec: 'i32',
	nx: 'i32',
	ny: 'i32',
	nz: 'i32',
	nf: 'i32',
	data: 'void*',
}

function readStruct (ptr, structType) {
	let res = {};

	for (let key of Object.keys(structType)) {
		res[key] = getValue(ptr, structType[key]);
		ptr += getNativeTypeSize(structType[key]);
	}

	return res;
}

function fpzip_decompress (buffer, callback) {
	let heapbufptr = Module._malloc(buffer.byteLength);
	let heaparr = new Uint8Array(Module.HEAPU8.buffer, heapbufptr, affinitybuf.byteLength); 
	heaparr.set(buffer);

	let decoded_image_ptr = Module.decompress(heapbufptr);
	let res = readStruct(decoded_image_ptr, fpzip_struct_decoded_image);

	let nbytes = res.nx * res.ny * res.nz * res.nf;

	let ArrayType;
	if (res.type === 0) {
		ArrayType = Float32Array;
		nbytes *= 4;
	}
	else {
		ArrayType = Float64Array;
		nbytes *= 8;
	}

	let image = Module.HEAPU8.buffer.slice(res.data, res.data + nbytes);
	image = new ArrayType(image.buffer);
	postMessage({ callback: callback, msg: { 
		image: image, 
		x: res.nx, 
		y: res.ny,
		z: res.nz,
		c: res.nf,
	} }, [image]);

	Module._free(res.data);
	Module._free(decoded_image_ptr);
}

let queue = [];

function queueRequest (req) {
	queue.push(req);
	processQueue();
}

function processQueue () {
	if (!queue.length) {
		return;
	}

	function nextStep () {
		// setTimeout to give cancellation requests a chance
		setTimeout(processQueue, 0);
	}

	let req = queue.shift();

	switch (req[0]) {
		case 'fpzip_decompress':
			fpzip_decompress.apply(null, req[1]);
			break;
		default:
			console.log('invalid queue type', req[0]);
	}

	nextStep();
}

onmessage = function (e) {
	switch (e.data.type) {
		case 'fpzip_decompress':
			queueRequest([e.data.type, [e.data.msg.bytes, e.data.callback]]);
			break;
		default:
			console.log('invalid type', e.data.type);
	}
}

