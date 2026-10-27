import * as THREE from 'three';
import { buildCarbine, buildPrecisionRifle } from './weapon_models.mjs';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'models');
try { mkdirSync(outDir, { recursive: true }); } catch(e){}

// Weapons are rigid: bake transforms and batch opaque parts by material.
// Keep transparent lenses separate so the renderer can sort them.
function batchStaticModel(root){
  root.updateMatrixWorld(true);
  const batches = new Map();
  root.traverse(mesh => {
    if(!mesh.isMesh) return;
    const key = (mesh.material.transparent ? mesh.uuid : mesh.material.uuid)+(mesh.userData.stock?'_stock':'');
    if(!batches.has(key)) batches.set(key, { material:mesh.material, stock:!!mesh.userData.stock, geometries:[] });
    let geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    if(geometry.index) geometry = geometry.toNonIndexed();
    geometry.deleteAttribute('uv');
    batches.get(key).geometries.push(geometry);
  });
  const result = new THREE.Group();
  for(const { material, stock, geometries } of batches.values()){
    const geometry = mergeVertices(mergeGeometries(geometries), 0.000001);
    if(geometry.attributes.position.count > 65535) throw new Error('Model batch exceeds Uint16 index limit');
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${root.name}_${stock?'stock':'part'}_${result.children.length}`;
    result.add(mesh);
  }
  return result;
}

// ═════════ GLB WRITER — per-mesh, no geometry merging ═════════
// Writes every mesh in the Object3D hierarchy as its own primitive.
// No matrixWorld baking, no attribute reordering, no merging tricks —
// the GLB contains exactly the same hierarchy as the source Group.
function writeGLB(root, filename){
  root = batchStaticModel(root);
  // Traverse the group collecting meshes, and compute local matrix for each
  const meshList = [];
  root.traverse(o => {
    if(o.isMesh && o.geometry){
      o.updateMatrixWorld(true);
      meshList.push({ mesh:o, matWorld: o.matrixWorld.clone() });
    }
  });
  console.log(`  ${meshList.length} meshes`);

  // Collect unique materials and build mesh → matIdx map
  const materials = [];
  const matMap = new Map();
  for(const { mesh } of meshList){
    const mat = mesh.material;
    if(!matMap.has(mat.uuid)){
      const idx = materials.length;
      matMap.set(mat.uuid, idx);
      const c = mat.color;
      const emissive = mat.emissive;
      const matDef = {
        name: `mat${idx}`,
        pbrMetallicRoughness: {
          baseColorFactor: [c.r, c.g, c.b, mat.opacity ?? 1],
          metallicFactor: mat.metalness ?? 0,
          roughnessFactor: mat.roughness ?? 1
        },
        emissiveFactor: emissive ? [emissive.r, emissive.g, emissive.b] : [0,0,0],
      };
      if(mat.transparent) matDef.alphaMode = 'BLEND';
      materials.push(matDef);
    }
  }

  const binChunks = [];
  const accessors = [];
  const bufferViews = [];
  let binOffset = 0;
  const primitives = [];
  const nodes = [];

  // Create one node per mesh (simple 1-level scene: all meshes under root)
  for(let i=0; i<meshList.length; i++){
    const { mesh, matWorld } = meshList[i];
    const geom = mesh.geometry;
    const nodeIdx = nodes.length;
    nodes.push({ mesh: nodeIdx, name: mesh.name || `mesh${i}` });

    const posAttr = geom.attributes.position;
    const posCount = posAttr.count;

    // Decompose the local matrix into translation/rotation/scale
    // glTF nodes have their own TRS, so we bake the matrix onto the node
    const m = matWorld;
    const translation = [0,0,0], rotation = [0,0,0,1], scale = [1,1,1];
    // Extract TRS from matrixWorld (column-major, RHS → column 4 is translation)
    const mte = m.elements;
    translation[0] = mte[12]; translation[1] = mte[13]; translation[2] = mte[14];
    // Extract scale from columns
    const sx = Math.hypot(mte[0], mte[1], mte[2]);
    const sy = Math.hypot(mte[4], mte[5], mte[6]);
    const sz = Math.hypot(mte[8], mte[9], mte[10]);
    scale[0] = sx; scale[1] = sy; scale[2] = sz;
    // Rotation from scaled matrix: columns normalized
    const q = new THREE.Quaternion();
    const rotMat = new THREE.Matrix3();
    rotMat.setFromMatrix4(m);
    const sm = new THREE.Matrix4().fromArray([1/sx,0,0,0, 0,1/sy,0,0, 0,0,1/sz,0, 0,0,0,1]);
    const rm = new THREE.Matrix4().copy(m).multiply(sm);
    q.setFromRotationMatrix(rm);
    rotation[0] = q.x; rotation[1] = q.y; rotation[2] = q.z; rotation[3] = q.w;
    nodes[nodeIdx].translation = translation;
    nodes[nodeIdx].rotation = rotation;
    nodes[nodeIdx].scale = scale;

    // POSITION attribute — raw, no matrix baking (matrix goes on node)
    const posBV = bufferViews.length;
    bufferViews.push({ buffer:0, byteOffset: binOffset, byteLength: posAttr.array.byteLength });
    binOffset += posAttr.array.byteLength;
    let pmin = [Infinity, Infinity, Infinity], pmax = [-Infinity, -Infinity, -Infinity];
    for(let i=0; i<posCount; i++){
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      if(x < pmin[0]) pmin[0] = x; if(y < pmin[1]) pmin[1] = y; if(z < pmin[2]) pmin[2] = z;
      if(x > pmax[0]) pmax[0] = x; if(y > pmax[1]) pmax[1] = y; if(z > pmax[2]) pmax[2] = z;
    }
    const posAcc = accessors.length;
    accessors.push({ bufferView: posBV, componentType: 5126, count: posCount, type: 'VEC3', byteOffset:0, min: pmin, max: pmax });
    binChunks.push(posAttr.array);

    // NORMAL attribute — raw, no matrix baking
    let normBV = -1, normAcc = -1;
    if(geom.attributes.normal){
      const normAttr = geom.attributes.normal;
      normBV = bufferViews.length;
      bufferViews.push({ buffer:0, byteOffset: binOffset, byteLength: normAttr.array.byteLength });
      binOffset += normAttr.array.byteLength;
      normAcc = accessors.length;
      accessors.push({ bufferView: normBV, componentType: 5126, count: posCount, type:'VEC3', byteOffset:0 });
      binChunks.push(normAttr.array);
    }

    // INDICES
    let idxAcc;
    if(geom.index){
      const idxCount = geom.index.count;
      idxAcc = accessors.length;
      if(geom.index.array instanceof Uint16Array){
        const idxBV = bufferViews.length;
        bufferViews.push({ buffer:0, byteOffset: binOffset, byteLength: geom.index.array.byteLength });
        binOffset += geom.index.array.byteLength;
        accessors.push({ bufferView: idxBV, componentType: 5123, count: idxCount, type:'SCALAR', byteOffset:0 });
        binChunks.push(geom.index.array);
      } else {
        // Convert to Uint16
        const indices = new Uint16Array(idxCount);
        for(let i=0; i<idxCount; i++) indices[i] = geom.index.array[i];
        const idxBV = bufferViews.length;
        bufferViews.push({ buffer:0, byteOffset: binOffset, byteLength: indices.byteLength });
        binOffset += indices.byteLength;
        accessors.push({ bufferView: idxBV, componentType: 5123, count: idxCount, type:'SCALAR', byteOffset:0 });
        binChunks.push(indices);
      }
    } else {
      // No index — generate
      const idxCount = posCount;
      const indices = new Uint16Array(idxCount);
      for(let i=0; i<idxCount; i++) indices[i] = i;
      const idxBV = bufferViews.length;
      bufferViews.push({ buffer:0, byteOffset: binOffset, byteLength: indices.byteLength });
      binOffset += indices.byteLength;
      idxAcc = accessors.length;
      accessors.push({ bufferView: idxBV, componentType: 5123, count: idxCount, type:'SCALAR', byteOffset:0 });
      binChunks.push(indices);
    }

    const matIdx = matMap.get(mesh.material.uuid);
    const prim = {
      attributes: { POSITION: posAcc },
      indices: idxAcc,
      material: matIdx,
      mode: 4  // TRIANGLES
    };
    if(normAcc >= 0) prim.attributes.NORMAL = normAcc;
    primitives.push(prim);
    const padding = (4 - binOffset % 4) % 4;
    if(padding){ binChunks.push(new Uint8Array(padding)); binOffset += padding; }
  }

  const gltf = {
    asset: { version: '2.0', generator: 'neon-strike-gen' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_,i)=>i) }],
    nodes,
    // One node → one mesh → one primitive. Each node's `mesh` references its own
    // mesh index (nodes[i].mesh === i), so meshes must have one entry per node.
    // (Previously all primitives were merged into a single mesh while every node
    // pointed at mesh index === node index, making nodes 1..N reference an
    // out-of-range mesh and failing GLTFLoader with "reading 'primitives'".)
    meshes: primitives.map(p => ({ primitives: [p] })),
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binOffset }]
  };

  // Build GLB binary
  let jsonString = JSON.stringify(gltf);
  while(jsonString.length % 4 !== 0) jsonString += ' ';
  const jsonBytes = Buffer.from(jsonString, 'utf8');
  let binTotal = 0;
  for(const c of binChunks) binTotal += c.byteLength;
  const binPad = (4 - (binTotal % 4)) % 4;
  const totalLength = 12 + 8 + jsonBytes.length + 8 + binTotal + binPad;

  const buf = Buffer.alloc(totalLength);
  let off = 0;
  buf.writeUInt32LE(0x46546C67, off); off += 4;
  buf.writeUInt32LE(2, off); off += 4;
  buf.writeUInt32LE(totalLength, off); off += 4;
  buf.writeUInt32LE(jsonBytes.length, off); off += 4;
  buf.writeUInt32LE(0x4E4F534A, off); off += 4;
  jsonBytes.copy(buf, off); off += jsonBytes.length;
  buf.writeUInt32LE(binTotal + binPad, off); off += 4;
  buf.writeUInt32LE(0x004E4942, off); off += 4;
  for(const c of binChunks){
    const b = Buffer.from(c.buffer, c.byteOffset, c.byteLength);
    b.copy(buf, off); off += c.byteLength;
  }
  for(let i=0; i<binPad; i++) buf[off++] = 0;

  writeFileSync(join(outDir, filename), buf);
  console.log(`  OK ${filename}  ${buf.length} bytes (${meshList.length} meshes, ${materials.length} materials)`);
  return buf.length;
}

// ═══════════════════════════════════════════════════
// MATERIALS
// ═══════════════════════════════════════════════════
const darkMetal  = new THREE.MeshStandardMaterial({ color:0x10141d, metalness:0.9, roughness:0.35 });
const midMetal   = new THREE.MeshStandardMaterial({ color:0x2a3038, metalness:0.7, roughness:0.45 });
const lighterMetal = new THREE.MeshStandardMaterial({ color:0x3a4048, metalness:0.6, roughness:0.5 });
const cyanGlow   = new THREE.MeshStandardMaterial({ color:0x00b8cf, emissive:0x00d8ff, roughness:0.3, metalness:0.35 });
const magenta    = new THREE.MeshStandardMaterial({ color:0xad204e, emissive:0xff2a6d, roughness:0.4, metalness:0.25 });
const yellow     = new THREE.MeshStandardMaterial({ color:0xffc34a, emissive:0x6b3105, roughness:0.5, metalness:0.25 });
const dark       = new THREE.MeshStandardMaterial({ color:0x0a0a0f, metalness:0.6, roughness:0.6 });
const grenadeMat = new THREE.MeshStandardMaterial({ color:0x2a323c, metalness:0.6, roughness:0.5, emissive:0xff5a1a, emissiveIntensity:0.3 });
const grenadeBodyMat = new THREE.MeshStandardMaterial({ color:0x1e242d, metalness:0.55, roughness:0.55, emissive:0xff5a1a, emissiveIntensity:0.22 });
const silverMat  = new THREE.MeshStandardMaterial({ color:0xc8ccd2, metalness:0.85, roughness:0.28 });
const brassMat   = new THREE.MeshStandardMaterial({ color:0xc89640, metalness:0.9, roughness:0.4 });
const rubberMat  = new THREE.MeshStandardMaterial({ color:0x0c0d10, metalness:0.0, roughness:0.9 });
const glassMat   = new THREE.MeshBasicMaterial({ color:0x80f4ff, transparent:true, opacity:0.55 });

// helpers
function box(w,h,d, mat, x,y,z){
  const smallest = Math.min(w,h,d);
  const geometry = smallest >= 0.018
    ? new RoundedBoxGeometry(w,h,d,1,Math.min(0.004,smallest*0.12))
    : new THREE.BoxGeometry(w,h,d);
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x||0,y||0,z||0);
  return m;
}
function cyl(rt, rb, h, mat, x,y,z, rx,ry,rz, seg=14){
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg), mat);
  m.position.set(x||0,y||0,z||0);
  if(rx) m.rotation.x = rx;
  if(ry) m.rotation.y = ry;
  if(rz) m.rotation.z = rz;
  return m;
}
function sphere(r, mat, x,y,z, ws=14, hs=12){
  const m = new THREE.Mesh(new THREE.SphereGeometry(r,ws,hs), mat);
  m.position.set(x||0,y||0,z||0);
  return m;
}
function torus(r, t, mat, x,y,z, rx,ry,rz, ws=12, rs=18){
  const m = new THREE.Mesh(new THREE.TorusGeometry(r,t,ws,rs), mat);
  m.position.set(x||0,y||0,z||0);
  if(rx) m.rotation.x = rx;
  if(ry) m.rotation.y = ry;
  if(rz) m.rotation.z = rz;
  return m;
}

function buildGrenade(){
  const g = new THREE.Group(); g.name = 'grenade';

  g.add(sphere(0.10, grenadeBodyMat, 0, 0, 0, 18, 16));
  g.add(torus(0.10, 0.014, grenadeMat, 0, 0, 0, Math.PI/2, 0, 0, 10, 24));
  // Primary vertical fragmentation segments
  for(let i=0;i<8;i++){
    const a = (i/8)*Math.PI*2;
    g.add(box(0.008, 0.16, 0.01, grenadeMat, Math.cos(a)*0.085, 0, Math.sin(a)*0.085));
  }
  // Secondary staggered segments (denser pineapple texture, 16 段交错)
  for(let i=0;i<8;i++){
    const a = (i/8)*Math.PI*2 + Math.PI/8;
    g.add(box(0.007, 0.17, 0.01, grenadeMat, Math.cos(a)*0.088, 0, Math.sin(a)*0.088));
  }
  // Horizontal fragmentation rings (上下两道环, 形成网格)
  g.add(torus(0.085, 0.010, grenadeMat, 0, 0.055, 0, Math.PI/2, 0, 0, 10, 24));
  g.add(torus(0.085, 0.010, grenadeMat, 0, -0.055, 0, Math.PI/2, 0, 0, 10, 24));
  // Base assembly + thread ring (底座螺纹)
  g.add(cyl(0.07, 0.05, 0.03, midMetal, 0, -0.08, 0, 0,0,0, 14));
  g.add(torus(0.052, 0.006, midMetal, 0, -0.068, 0, 0,0,0, 8, 16));

  // Fuse + lever (引信 + 保险握片)
  g.add(cyl(0.05, 0.06, 0.04, midMetal, 0, 0.11, 0, 0,0,0, 14));
  g.add(cyl(0.03, 0.03, 0.03, darkMetal, 0, 0.145, 0, 0,0,0, 10));
  g.add(box(0.02, 0.012, 0.02, yellow, 0, 0.165, 0));

  const spoon = box(0.018, 0.07, 0.04, midMetal, 0.045, 0.10, 0.00);
  spoon.rotation.z = -0.15; g.add(spoon);
  g.add(box(0.014, 0.05, 0.02, dark, 0.06, 0.10, 0.005));

  // Safety pin + pull ring (保险销 + 拉环)
  g.add(cyl(0.004, 0.004, 0.10, silverMat, 0.10, 0.13, 0, 0,0,Math.PI/2, 8));
  g.add(torus(0.022, 0.004, silverMat, 0.14, 0.13, 0, 0, Math.PI/2, 0, 8, 16));

  g.add(torus(0.10, 0.004, yellow, 0, 0.02, 0, Math.PI/2, 0, 0, 8, 24));
  return g;
}

// ═════════ Generate ═════════
console.log('Generating beveled weapon models (batched by material)...');
writeGLB(buildCarbine(), 'rifle.glb');
writeGLB(buildPrecisionRifle(), 'sniper.glb');
writeGLB(buildGrenade(), 'grenade.glb');
const embedded = Object.fromEntries(['rifle','sniper','grenade'].map(key =>
  [key, readFileSync(join(outDir, `${key}.glb`)).toString('base64')]));
writeFileSync(join(__dirname,'models_b64.js'),
  '// Generated by gen_models.mjs; offline weapon fallback.\nwindow.__MODEL_B64 = '+JSON.stringify(embedded)+';\n');
console.log('All done.');
