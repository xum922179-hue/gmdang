// Download Poly Haven weapon models locally, fix paths for local serving.
// Run: node download_polyhaven.mjs
// Then serve with: npm start  (server.js already serves static files)
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'models', 'polyhaven');
mkdirSync(join(outDir, 'textures'), { recursive: true });

// Convert a .gltf (with external .bin) into a self-contained .glb by embedding
// the buffer data as the BIN chunk. Texture URIs are left relative so they
// resolve against the model's directory at load time. This avoids the
// separate .bin sub-request that GLTFLoader.load() makes (which gets aborted
// by the game's load timeout on larger models); loading via the GLB path uses
// a single fetch() with an AbortSignal instead.
function writeGLB(gltfJson, binData, outPath){
  const glb = JSON.parse(JSON.stringify(gltfJson));
  // The first buffer becomes the BIN chunk (no URI in GLB).
  if(!glb.buffers || !glb.buffers[0]) throw new Error('no buffer to embed');
  delete glb.buffers[0].uri;
  glb.buffers[0].byteLength = binData.length;

  let json = JSON.stringify(glb);
  while(json.length % 4 !== 0) json += ' ';
  const jsonBytes = Buffer.from(json, 'utf8');
  const binPad = (4 - (binData.length % 4)) % 4;
  const totalLen = 12 + 8 + jsonBytes.length + 8 + binData.length + binPad;
  const buf = Buffer.alloc(totalLen);
  let o = 0;
  buf.writeUInt32LE(0x46546C67, o); o += 4;  // "glTF"
  buf.writeUInt32LE(2, o); o += 4;            // version
  buf.writeUInt32LE(totalLen, o); o += 4;     // length
  buf.writeUInt32LE(jsonBytes.length, o); o += 4;
  buf.writeUInt32LE(0x4E4F534A, o); o += 4;  // "JSON"
  jsonBytes.copy(buf, o); o += jsonBytes.length;
  buf.writeUInt32LE(binData.length + binPad, o); o += 4;
  buf.writeUInt32LE(0x004E4942, o); o += 4;  // "BIN\0"
  binData.copy(buf, o); o += binData.length;
  writeFileSync(outPath, buf);
  return buf.length;
}

// List of Poly Haven weapon model IDs (verified working via API)
const MODELS = ['service_pistol', 'bolt_action_rifle_7_62', 'stick_grenade'];
const RES = '1k';

for(const MODEL of MODELS){
  console.log(`\n=== Downloading ${MODEL} ===`);
  try{
    const api = await fetch(`https://api.polyhaven.com/files/${MODEL}`).then(r => r.json());
    if(!api.gltf) { console.log('  No glTF format, skipping'); continue; }
    const gltfUrl = api.gltf[RES]?.gltf?.url || api.gltf['2k']?.gltf?.url || api.gltf['4k']?.gltf?.url;
    if(!gltfUrl) { console.log('  No glTF at any res, skipping'); continue; }
    console.log(`  glTF: ${gltfUrl.split('/').pop()}`);
    const gltfJson = JSON.parse(await fetch(gltfUrl).then(r => r.text()));

    // .bin
    const binUrl = gltfUrl.replace(/\/[^/]+$/, '/') + gltfJson.buffers[0].uri;
    const binBuf = Buffer.from(await fetch(binUrl).then(r => r.arrayBuffer()));
    writeFileSync(join(outDir, `${MODEL}.bin`), binBuf);

    // textures — build lookup from API
    const texApiMap = {};
    for(const [apiKey, val] of Object.entries(api)){
      if(typeof val !== 'object') continue;
      const resKey = val[RES] ? RES : (val['2k'] ? '2k' : (val['4k'] ? '4k' : null));
      if(!resKey) continue;
      const fileEntry = val[resKey].jpg || val[resKey].png || Object.values(val[resKey])[0];
      if(fileEntry && fileEntry.url){
        texApiMap[fileEntry.url.split('/').pop().toLowerCase()] = fileEntry.url;
      }
    }
    for(const img of gltfJson.images){
      const baseName = img.uri.split('/').pop();
      const cdnUrl = texApiMap[baseName.toLowerCase()];
      if(cdnUrl){
        const texBuf = Buffer.from(await fetch(cdnUrl).then(r => r.arrayBuffer()));
        writeFileSync(join(outDir, 'textures', baseName), texBuf);
        img.uri = `textures/${baseName}`;
      }else{
        img.uri = '';
      }
    }
    gltfJson.buffers[0].uri = `${MODEL}.bin`;
    writeFileSync(join(outDir, `${MODEL}.gltf`), JSON.stringify(gltfJson, null, 2));
    // Also produce a self-contained .glb (embeds the .bin) for robust loading.
    const glbBytes = writeGLB(gltfJson, binBuf, join(outDir, `${MODEL}.glb`));
    console.log(`  OK — ${MODEL}.gltf + ${MODEL}.bin + ${MODEL}.glb (${glbBytes}B) + textures/`);
  }catch(e){
    console.log(`  FAIL: ${e.message}`);
  }
}

console.log('\n=== Done ===');
console.log(`Local path: models/polyhaven/`);
console.log(`To use in game: set EXTERNAL_MODELS.rifle to 'models/polyhaven/service_pistol.gltf'`);
