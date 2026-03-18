import * as THREE from 'three';

/**
 * Loader for Cosmographia .cmod binary mesh files.
 * Parses the binary format and produces Three.js BufferGeometry + MeshPhongMaterial.
 */

// Token constants
const CMOD_MATERIAL = 1001;
const CMOD_END_MATERIAL = 1002;
const CMOD_DIFFUSE = 1003;
const CMOD_SPECULAR = 1004;
const CMOD_SPECULAR_POWER = 1005;
const CMOD_OPACITY = 1006;
const CMOD_TEXTURE = 1007;
const CMOD_MESH = 1009;
const CMOD_END_MESH = 1010;
const CMOD_VERTEX_DESC = 1011;
const CMOD_END_VERTEX_DESC = 1012;
const CMOD_VERTICES = 1013;
const CMOD_EMISSIVE = 1014;
const CMOD_BLEND = 1015;

// Data types
const CMOD_FLOAT1 = 1;
const CMOD_COLOR = 7;
const CMOD_STRING = 5;
const CMOD_UINT32 = 6;

// Vertex attribute semantics
const ATTR_POSITION = 0;
const ATTR_NORMAL = 3;
const ATTR_TEXCOORD = 5;

// Vertex attribute formats → byte sizes
const FORMAT_SIZES: Record<number, number> = {
  0: 4,   // Float1
  1: 8,   // Float2
  2: 12,  // Float3
  3: 16,  // Float4
  4: 4,   // UByte4
};

// Vertex attribute formats → component counts
const FORMAT_COMPONENTS: Record<number, number> = {
  0: 1, 1: 2, 2: 3, 3: 4, 4: 4,
};

interface CmodAttribute {
  semantic: number;
  format: number;
  offset: number;
  components: number;
}

// Texture type codes from cmod binary format
const TEX_DIFFUSE = 0;
const TEX_NORMAL = 1;
const TEX_SPECULAR = 2;
const TEX_EMISSIVE = 3;

interface CmodTexture {
  type: number;
  path: string;
}

interface CmodMaterial {
  diffuse: [number, number, number];
  specular: [number, number, number];
  emissive: [number, number, number];
  specularPower: number;
  opacity: number;
  textures: CmodTexture[];
}

interface CmodPrimitiveBatch {
  primitiveType: number;
  materialIndex: number;
  indices: Uint32Array;
}

interface CmodSubmesh {
  attributes: CmodAttribute[];
  stride: number;
  vertexCount: number;
  vertexData: DataView;
  vertexDataOffset: number;
  batches: CmodPrimitiveBatch[];
}

const HEADER = '#celmodel_binary';

class CmodReader {
  private readonly view: DataView;
  private pos: number;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.pos = 0;
  }

  get position(): number { return this.pos; }
  get remaining(): number { return this.view.byteLength - this.pos; }

  readUint16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readUint32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readString(): string {
    const len = this.readUint16();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, len);
    this.pos += len;
    return new TextDecoder().decode(bytes);
  }

  readColor(): [number, number, number] {
    return [this.readFloat32(), this.readFloat32(), this.readFloat32()];
  }

  skip(n: number): void { this.pos += n; }

  peekUint16(): number {
    return this.view.getUint16(this.pos, true);
  }
}

/** Resolves a texture filename (from cmod binary) to a loadable URL */
export type CmodTextureResolver = (textureName: string) => string | undefined;

/**
 * Parse a .cmod binary buffer into Three.js Object3D.
 * If textureResolver is provided, textures referenced in the cmod are loaded.
 */
export async function parseCmod(buffer: ArrayBuffer, textureResolver?: CmodTextureResolver): Promise<THREE.Group | null> {
  const reader = new CmodReader(buffer);

  // Validate header
  if (reader.remaining < HEADER.length) return null;
  const headerBytes = new Uint8Array(buffer, 0, HEADER.length);
  const header = new TextDecoder().decode(headerBytes);
  if (header !== HEADER) return null;
  reader.skip(HEADER.length);

  // Parse materials
  const materials: CmodMaterial[] = [];
  while (reader.remaining >= 2 && reader.peekUint16() === CMOD_MATERIAL) {
    reader.readUint16(); // consume token
    materials.push(parseMaterial(reader));
  }

  // Ensure at least one default material
  if (materials.length === 0) {
    materials.push({ diffuse: [0.8, 0.8, 0.8], specular: [0, 0, 0], emissive: [0, 0, 0], specularPower: 1, opacity: 1, textures: [] });
  }

  // Parse meshes
  const submeshes: CmodSubmesh[] = [];
  while (reader.remaining >= 2 && reader.peekUint16() === CMOD_MESH) {
    reader.readUint16(); // consume token
    const sm = parseSubmesh(reader);
    if (sm) submeshes.push(sm);
  }

  if (submeshes.length === 0) return null;

  // Build Three.js objects
  const group = new THREE.Group();

  // Create Three.js materials. For metallic materials (saturated specular color in
  // Cosmographia .cmod format), use the specular color as diffuse so the metal
  // tint is visible under normal Phong lighting (consistent with other model parts).
  const threeMaterials: THREE.Material[] = materials.map(mat => {
    const [sr, sg, sb] = mat.specular;
    const specMax = Math.max(sr, sg, sb);
    const specMin = Math.min(sr, sg, sb);
    const isMetallic = specMax > 0.3 && (specMax - specMin) > 0.15;

    // For metallic materials, use specular color as diffuse but scaled down —
    // in Cosmographia the specular color only appeared in highlights, not as base.
    return new THREE.MeshPhongMaterial({
      color: isMetallic
        ? new THREE.Color(sr * 0.45, sg * 0.45, sb * 0.45)
        : new THREE.Color(mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]),
      specular: new THREE.Color(sr, sg, sb),
      emissive: new THREE.Color(mat.emissive[0], mat.emissive[1], mat.emissive[2]),
      shininess: mat.specularPower,
      opacity: mat.opacity,
      transparent: mat.opacity < 1,
      side: THREE.FrontSide,
    });
  });

  // Load textures (non-blocking — applied to materials when ready)
  if (textureResolver) {
    const textureLoader = new THREE.TextureLoader();
    for (let i = 0; i < materials.length; i++) {
      for (const tex of materials[i].textures) {
        const url = textureResolver(tex.path);
        if (!url) continue;
        loadTexture(url, tex.path, tex.type, threeMaterials[i], textureLoader);
      }
    }
  }

  for (const sm of submeshes) {
    // Extract vertex attributes
    const posAttr = sm.attributes.find(a => a.semantic === ATTR_POSITION);
    const normAttr = sm.attributes.find(a => a.semantic === ATTR_NORMAL);
    const uvAttr = sm.attributes.find(a => a.semantic === ATTR_TEXCOORD);

    if (!posAttr) continue;

    // Read interleaved vertex data into separate arrays
    const positions = new Float32Array(sm.vertexCount * 3);
    const normals = normAttr ? new Float32Array(sm.vertexCount * 3) : null;
    const uvs = uvAttr ? new Float32Array(sm.vertexCount * 2) : null;

    const baseOffset = sm.vertexDataOffset;
    for (let i = 0; i < sm.vertexCount; i++) {
      const vertBase = baseOffset + i * sm.stride;

      // Position (always 3 components for our use)
      const pOff = vertBase + posAttr.offset;
      positions[i * 3] = sm.vertexData.getFloat32(pOff, true);
      positions[i * 3 + 1] = sm.vertexData.getFloat32(pOff + 4, true);
      positions[i * 3 + 2] = sm.vertexData.getFloat32(pOff + 8, true);

      if (normals && normAttr) {
        const nOff = vertBase + normAttr.offset;
        normals[i * 3] = sm.vertexData.getFloat32(nOff, true);
        normals[i * 3 + 1] = sm.vertexData.getFloat32(nOff + 4, true);
        normals[i * 3 + 2] = sm.vertexData.getFloat32(nOff + 8, true);
      }

      if (uvs && uvAttr) {
        const tOff = vertBase + uvAttr.offset;
        uvs[i * 2] = sm.vertexData.getFloat32(tOff, true);
        uvs[i * 2 + 1] = sm.vertexData.getFloat32(tOff + 4, true);
      }
    }

    // Create geometry per primitive batch (each may use a different material)
    for (const batch of sm.batches) {
      // Convert indices to triangle list
      let triIndices: Uint32Array;
      if (batch.primitiveType === 0) {
        // TriList — use as-is
        triIndices = batch.indices;
      } else if (batch.primitiveType === 1) {
        // TriStrip → TriList
        triIndices = triStripToList(batch.indices);
      } else if (batch.primitiveType === 2) {
        // TriFan → TriList
        triIndices = triFanToList(batch.indices);
      } else {
        // Lines/points — skip
        continue;
      }

      if (triIndices.length === 0) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(triIndices, 1));

      if (!normals) geometry.computeVertexNormals();

      const matIdx = Math.min(batch.materialIndex, threeMaterials.length - 1);
      const mesh = new THREE.Mesh(geometry, threeMaterials[matIdx]);
      mesh.renderOrder = 0;
      group.add(mesh);
    }
  }

  return group;
}

function parseMaterial(reader: CmodReader): CmodMaterial {
  const mat: CmodMaterial = {
    diffuse: [0.8, 0.8, 0.8],
    specular: [0, 0, 0],
    emissive: [0, 0, 0],
    specularPower: 1,
    opacity: 1,
    textures: [],
  };

  while (reader.remaining >= 2) {
    const token = reader.readUint16();
    if (token === CMOD_END_MATERIAL) break;

    switch (token) {
      case CMOD_DIFFUSE: {
        const dt = reader.readUint16();
        if (dt === CMOD_COLOR) mat.diffuse = reader.readColor();
        break;
      }
      case CMOD_SPECULAR: {
        const dt = reader.readUint16();
        if (dt === CMOD_COLOR) mat.specular = reader.readColor();
        break;
      }
      case CMOD_EMISSIVE: {
        const dt = reader.readUint16();
        if (dt === CMOD_COLOR) mat.emissive = reader.readColor();
        break;
      }
      case CMOD_SPECULAR_POWER: {
        const dt = reader.readUint16();
        if (dt === CMOD_FLOAT1) mat.specularPower = reader.readFloat32();
        break;
      }
      case CMOD_OPACITY: {
        const dt = reader.readUint16();
        if (dt === CMOD_FLOAT1) mat.opacity = reader.readFloat32();
        break;
      }
      case CMOD_TEXTURE: {
        const texType = reader.readUint16(); // 0=diffuse, 1=normal, 2=specular, 3=emissive
        const dt = reader.readUint16();
        if (dt === CMOD_STRING) {
          mat.textures.push({ type: texType, path: reader.readString() });
        }
        break;
      }
      case CMOD_BLEND: {
        const dt = reader.readUint16();
        if (dt === CMOD_UINT32) reader.readUint32(); // blend mode value (4 bytes)
        break;
      }
      default: {
        // Skip unknown property: read data type and skip value
        const dt = reader.readUint16();
        skipDataValue(reader, dt);
        break;
      }
    }
  }

  return mat;
}

function parseSubmesh(reader: CmodReader): CmodSubmesh | null {
  // Vertex description
  if (reader.remaining < 2 || reader.readUint16() !== CMOD_VERTEX_DESC) return null;

  const attributes: CmodAttribute[] = [];
  let stride = 0;

  while (reader.remaining >= 4) {
    const semantic = reader.readUint16();
    if (semantic === CMOD_END_VERTEX_DESC) break;
    const format = reader.readUint16();
    const size = FORMAT_SIZES[format] ?? 0;
    const components = FORMAT_COMPONENTS[format] ?? 0;
    attributes.push({ semantic, format, offset: stride, components });
    stride += size;
  }

  if (stride === 0) return null;

  // Vertex data
  if (reader.remaining < 2 || reader.readUint16() !== CMOD_VERTICES) return null;
  const vertexCount = reader.readUint32();
  const vertexDataSize = vertexCount * stride;
  if (reader.remaining < vertexDataSize) return null;

  const vertexDataOffset = reader.position;
  reader.skip(vertexDataSize);

  // Primitive batches
  const batches: CmodPrimitiveBatch[] = [];
  while (reader.remaining >= 2) {
    const token = reader.peekUint16();
    if (token === CMOD_END_MESH) {
      reader.readUint16();
      break;
    }
    // Primitive batch: type(u16) + materialIndex(u32) + indexCount(u32) + indices(u32[])
    const primitiveType = reader.readUint16();
    const rawMatIdx = reader.readUint32();
    const materialIndex = rawMatIdx === 0xffffffff ? 0 : rawMatIdx;
    const indexCount = reader.readUint32();

    if (reader.remaining < indexCount * 4) break;
    const indices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      indices[i] = reader.readUint32();
    }
    batches.push({ primitiveType, materialIndex, indices });
  }

  return {
    attributes,
    stride,
    vertexCount,
    vertexData: new DataView(reader['view'].buffer),
    vertexDataOffset,
    batches,
  };
}

function triStripToList(indices: Uint32Array): Uint32Array {
  if (indices.length < 3) return new Uint32Array(0);
  const tris: number[] = [];
  for (let i = 2; i < indices.length; i++) {
    if (i % 2 === 0) {
      tris.push(indices[i - 2], indices[i - 1], indices[i]);
    } else {
      tris.push(indices[i - 1], indices[i - 2], indices[i]);
    }
  }
  return new Uint32Array(tris);
}

function triFanToList(indices: Uint32Array): Uint32Array {
  if (indices.length < 3) return new Uint32Array(0);
  const tris: number[] = [];
  for (let i = 2; i < indices.length; i++) {
    tris.push(indices[0], indices[i - 1], indices[i]);
  }
  return new Uint32Array(tris);
}

function skipDataValue(reader: CmodReader, dataType: number): void {
  switch (dataType) {
    case CMOD_FLOAT1: reader.skip(4); break;
    case 2: reader.skip(8); break;  // Float2
    case 3: case CMOD_COLOR: reader.skip(12); break; // Float3/Color
    case 4: reader.skip(16); break; // Float4
    case CMOD_STRING: { const len = reader.readUint16(); reader.skip(len); break; }
    case CMOD_UINT32: reader.skip(4); break;
    default: break;
  }
}

/** Load a texture and apply it to the appropriate material slot. Fire-and-forget. */
function loadTexture(
  url: string,
  filename: string,
  texType: number,
  material: THREE.Material,
  textureLoader: THREE.TextureLoader,
): void {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const isDDS = ext === 'dds';

  const applyTexture = (texture: THREE.Texture) => {
    texture.colorSpace = texType === TEX_DIFFUSE ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    // Duck-type: both MeshPhongMaterial and MeshStandardMaterial have map/normalMap/emissiveMap
    const mat = material as THREE.MeshPhongMaterial & THREE.MeshStandardMaterial;
    switch (texType) {
      case TEX_DIFFUSE:
        mat.map = texture;
        break;
      case TEX_NORMAL:
        mat.normalMap = texture;
        break;
      case TEX_SPECULAR:
        if ('specularMap' in mat) mat.specularMap = texture;
        break;
      case TEX_EMISSIVE:
        mat.emissiveMap = texture;
        break;
    }
    material.needsUpdate = true;
  };

  if (isDDS) {
    // DDS: fetch as ArrayBuffer and parse manually since DDSLoader requires import
    // from three/examples which may not be bundled. Use fetch + manual DDS parsing.
    import('three/examples/jsm/loaders/DDSLoader.js').then(({ DDSLoader }) => {
      const loader = new DDSLoader();
      loader.load(url, applyTexture, undefined, (err) => {
        console.warn(`[SpiceCraft] Failed to load DDS texture ${filename}:`, err);
      });
    }).catch(() => {
      console.warn(`[SpiceCraft] DDSLoader not available, skipping ${filename}`);
    });
  } else {
    // JPG/PNG: standard TextureLoader
    textureLoader.load(url, applyTexture, undefined, (err) => {
      console.warn(`[SpiceCraft] Failed to load texture ${filename}:`, err);
    });
  }
}
