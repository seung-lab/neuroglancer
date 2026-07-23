import "#src/async_computation/decode_draco.js";
import "#src/async_computation/decode_jpeg.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { decodeCalcadaMultilodMesh } from "#src/datasource/calcada/base.js";
import {
  decodeMultilodPieceMesh,
  parseMultilodManifest,
} from "#src/datasource/calcada/multilod_mesh.js";

registerAsyncComputation(
  decodeCalcadaMultilodMesh,
  async (
    manifest: Uint8Array,
    draco: Uint8Array,
    vertexQuantizationBits: number,
    targetLod: number,
  ) => {
    const parsed = parseMultilodManifest(manifest);
    const mesh = await decodeMultilodPieceMesh(
      parsed,
      draco,
      vertexQuantizationBits,
      targetLod,
    );
    if (mesh === undefined) {
      return {
        value: {
          data: {
            vertexPositions: new Float32Array(0),
            indices: new Uint32Array(0),
          },
          size: 0,
        },
        transfer: [],
      };
    }
    const size = mesh.vertexPositions.byteLength + mesh.indices.byteLength;
    return {
      value: { data: mesh, size },
      transfer: [mesh.vertexPositions.buffer, mesh.indices.buffer],
    };
  },
);
