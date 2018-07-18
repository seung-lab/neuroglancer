import { Buffer } from "nbind/dist/shim";

export class NBindBase { free?(): void }

export class Fpzip extends NBindBase {
	/** Fpzip(); */
	constructor();

	/** Fpzip(Buffer); */
	constructor(p0: number[] | ArrayBuffer | DataView | Uint8Array | Buffer);

	/** uint64_t nbytes(); */
	nbytes(): number;

	/** uint64_t nvoxels(); */
	nvoxels(): number;

	/** uint64_t get_type(); */
	get_type(): number;

	/** uint64_t get_prec(); */
	get_prec(): number;

	/** uint64_t get_nx(); */
	get_nx(): number;

	/** uint64_t get_ny(); */
	get_ny(): number;

	/** uint64_t get_nz(); */
	get_nz(): number;

	/** uint64_t get_nf(); */
	get_nf(): number;

	/** void decompress(Buffer, Buffer); */
	decompress(p0: number[] | ArrayBuffer | DataView | Uint8Array | Buffer, p1: number[] | ArrayBuffer | DataView | Uint8Array | Buffer): void;

	/** void dekempress(Buffer, Buffer); */
	dekempress(p0: number[] | ArrayBuffer | DataView | Uint8Array | Buffer, p1: number[] | ArrayBuffer | DataView | Uint8Array | Buffer): void;
}
