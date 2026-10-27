import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function addGlovedHands(root){
  const glove = new THREE.MeshStandardMaterial({color:0x39434a,roughness:0.82,metalness:0.06});
  const pads = new THREE.MeshStandardMaterial({color:0x1c262c,roughness:0.65,metalness:0.1});
  const sleeve = new THREE.MeshStandardMaterial({color:0x40463d,roughness:0.95,metalness:0});
  const segment = (start,end,radius,material) => {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius,Math.max(0.001,direction.length()-2*radius),4,14),material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());
    root.add(mesh);
  };
  // === Right hand — holds the pistol grip ===
  // Grip slab geometry (rifle/sniper): x ±0.022, top y -0.055 at z 0.037..0.086,
  // leaning back to y -0.191 at z 0.072..0.122. Fingers ride along the left
  // flank (the side facing the camera), palm sits behind the back strap.
  segment([0.115,-0.300,0.300],[0.055,-0.155,0.135],0.028,sleeve);   // forearm
  segment([0.055,-0.155,0.135],[0.026,-0.098,0.104],0.021,glove);    // wrist → palm (behind grip)
  segment([0.026,-0.098,0.104],[-0.014,-0.086,0.088],0.016,glove);   // palm meat
  for(let i=0;i<4;i++){
    const y = -0.078 - i*0.021, zf = 0.044 + i*0.012;
    segment([-0.024, y, zf],[-0.020, y+0.004, zf+0.036],0.0082,glove);   // finger down the flank
    segment([-0.020, y+0.004, zf+0.036],[-0.006, y+0.010, zf+0.048],0.0072,glove); // curled tip
  }
  // Thumb rides the left flank, pointing forward
  segment([-0.026,-0.062,0.098],[-0.030,-0.052,0.040],0.0088,glove);
  segment([-0.030,-0.052,0.040],[-0.024,-0.044,0.020],0.0074,glove);

  // === Left hand — supports the fore-end from below/left ===
  // Fore-end spans z -0.51..-0.29, y 0.044..-0.047, x ±0.043.
  segment([-0.100,-0.300,0.060],[-0.052,-0.135,-0.240],0.028,sleeve); // forearm, kept left of the receiver
  segment([-0.052,-0.135,-0.240],[-0.032,-0.062,-0.345],0.020,glove); // wrist → palm under handguard
  for(let i=0;i<4;i++){
    const z = -0.352 + i*0.017;
    segment([-0.040,-0.053,z],[0.034,-0.052,z],0.0082,glove);          // finger under the handguard
    segment([ 0.034,-0.052,z],[0.040,-0.034,z],0.0072,pads);           // tip curling up the far side
  }
  // Thumb rests on top of the handguard's left edge (top face sits at y≈0.041 there)
  segment([-0.038,0.014,-0.345],[-0.014,0.048,-0.352],0.0090,pads);
}

// A reflection source and camera-relative soft lights keep the held weapon
// readable while moving between bright sky, walls and dark corners.
export function lightViewModels(renderer, camera, roots){
  for(const root of roots.slice(0,2)) addGlovedHands(root);
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const reflection = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  camera.layers.enable(1);
  for(const [color, intensity, position] of [
    [0xe6f1ff, 3.5, [-0.6, 0.8, -0.25]],
    [0xffe3bd, 1.4, [0.7, 0.1, -0.45]],
  ]){
    const light = new THREE.PointLight(color,intensity,3,2);
    light.position.set(...position);
    light.layers.set(1);
    camera.add(light);
  }
  for(const root of roots){
    root.traverse(object => {
      if(!object.isMesh) return;
      // The shoulder stock sits behind the first-person viewpoint. Retain it
      // in the shared asset for remote players, omit it from the held model.
      if(object.name.includes('_stock_')) object.visible = false;
      object.layers.enable(1);
      for(const material of (Array.isArray(object.material)?object.material:[object.material])){
        material.fog = false;
        if(!material.isMeshStandardMaterial) continue;
        material.envMap = reflection.texture;
        material.envMapIntensity = 0.7;
        material.needsUpdate = true;
      }
    });
  }
  return reflection;
}
