import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const finish = (color,metalness,roughness) => new THREE.MeshStandardMaterial({color,metalness,roughness});
const alloy = finish(0x697986,0.65,0.32);
const steel = finish(0x303f4b,0.7,0.3);
const ceramic = finish(0xb6aa8d,0.22,0.57);
const polymer = finish(0x29333b,0.05,0.78);
const recess = finish(0x10191f,0.05,0.86);
const fastener = finish(0xa7b2ba,0.78,0.25);
const accent = new THREE.MeshStandardMaterial({color:0x40bfca,emissive:0x1596a4,emissiveIntensity:0.3,metalness:0.25,roughness:0.4});
const lens = new THREE.MeshStandardMaterial({color:0x29536d,metalness:0.62,roughness:0.12});

function part(group,geometry,material,position){
  const mesh = new THREE.Mesh(geometry,material);
  mesh.position.set(...position);
  group.add(mesh);
  return mesh;
}
function block(g,w,h,d,mat,x,y,z,r=0.003){
  return part(g,new RoundedBoxGeometry(w,h,d,1,Math.min(r,w/4,h/4,d/4)),mat,[x,y,z]);
}
function tube(g,r1,r2,length,mat,x,y,z,segments=16,open=false){
  const mesh = part(g,new THREE.CylinderGeometry(r1,r2,length,segments,1,open),mat,[x,y,z]);
  mesh.rotation.x = Math.PI/2;
  return mesh;
}
function ring(g,r,t,mat,x,y,z){
  return part(g,new THREE.TorusGeometry(r,t,6,20),mat,[x,y,z]);
}
function profile(g,width,points,mat,x=0){
  const shape = new THREE.Shape();
  points.forEach(([z,y],i) => i?shape.lineTo(-z,y):shape.moveTo(-z,y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape,{depth:width,bevelEnabled:true,bevelThickness:0.0018,bevelSize:0.002,bevelSegments:1,steps:1,curveSegments:1});
  geometry.translate(0,0,-width/2).rotateY(Math.PI/2);
  return part(g,geometry,mat,[x,0,0]);
}
function screw(g,x,y,z){
  const mesh = part(g,new THREE.CylinderGeometry(0.0045,0.0045,0.002,8),fastener,[x,y,z]);
  mesh.rotation.z = Math.PI/2;
  block(g,0.001,0.0014,0.005,recess,x+Math.sign(x)*0.0015,y,z,0);
}
function rail(g,start,end,y){
  block(g,0.035,0.012,end-start,steel,0,y,(start+end)/2);
  for(let z=start+0.008;z<end;z+=0.023) block(g,0.045,0.009,0.011,alloy,0,y+0.01,z,0.001);
}
function magazine(g,z,length){
  profile(g,0.044,[[z-0.035,-0.058],[z+0.035,-0.058],[z+0.051,-length+0.012],[z+0.018,-length-0.008],[z-0.028,-length]],polymer);
  for(const side of [-1,1]){
    for(let i=0;i<3;i++){
      const rib = block(g,0.002,0.088,0.005,steel,side*0.024,-0.148,z-0.018+i*0.017,0.001);
      rib.rotation.x = -0.12;
    }
  }
  block(g,0.052,0.013,0.082,polymer,0,-length,z+0.012);
}
function grip(g,z){
  profile(g,0.044,[[z-0.025,-0.055],[z+0.024,-0.055],[z+0.06,-0.185],[z+0.01,-0.191]],polymer);
  for(const side of [-1,1]) for(let i=0;i<5;i++){
    const pad = block(g,0.002,0.006,0.031,steel,side*0.024,-0.103-i*0.014,z+0.017+i*0.004,0.001);
    pad.rotation.x = 0.24;
  }
  // Trigger guard follows the side silhouette rather than spanning the gun width.
  profile(g,0.012,[[z-0.092,-0.060],[z-0.083,-0.116],[z-0.012,-0.120],[z+0.005,-0.065],[z-0.005,-0.065],[z-0.022,-0.106],[z-0.075,-0.104],[z-0.082,-0.060]],steel);
  const trigger = block(g,0.008,0.030,0.009,fastener,0,-0.083,z-0.042,0.001);
  trigger.rotation.x = -0.3;
}
function stock(g,start,end){
  const first = g.children.length;
  tube(g,0.018,0.018,end-start,steel,0,0.01,(start+end)/2);
  profile(g,0.054,[[start+0.015,0.042],[end-0.015,0.036],[end,-0.095],[end-0.055,-0.095],[start+0.036,-0.032]],polymer);
  block(g,0.064,0.023,end-start-0.025,ceramic,0,0.047,(start+end)/2);
  block(g,0.063,0.128,0.022,polymer,0,-0.025,end);
  for(let i=0;i<5;i++) block(g,0.066,0.004,0.003,steel,0,-0.072+i*0.022,end+0.012,0.001);
  for(const mesh of g.children.slice(first)) mesh.userData.stock = true;
}
function muzzle(g,z,r=0.026){
  tube(g,r,r,0.055,steel,0,0.005,z,20);
  ring(g,r*0.73,r*0.2,alloy,0,0.005,z-0.029);
  tube(g,r*0.48,r*0.48,0.001,recess,0,0.005,z-0.0285);
  for(const side of [-1,1]) for(let i=0;i<2;i++) block(g,0.002,0.013,0.009,recess,side*r,0.005,z-0.012+i*0.020,0.001);
}

export function buildCarbine(){
  const g = new THREE.Group(); g.name='rifle';
  // Compact stepped receiver, with a separate lower chassis and tapered fore-end.
  profile(g,0.082,[[-0.29,0.036],[-0.25,0.060],[0.075,0.060],[0.123,0.030],[0.123,-0.031],[-0.20,-0.049],[-0.29,-0.024]],alloy);
  profile(g,0.073,[[-0.20,-0.035],[0.102,-0.024],[0.115,-0.065],[-0.014,-0.078],[-0.04,-0.093],[-0.18,-0.089]],ceramic);
  profile(g,0.085,[[-0.51,0.032],[-0.29,0.044],[-0.26,-0.032],[-0.49,-0.047]],steel);
  tube(g,0.014,0.018,0.18,alloy,0,0.005,-0.565);
  tube(g,0.022,0.022,0.018,steel,0,0.005,-0.51);
  muzzle(g,-0.665);
  rail(g,-0.48,0.075,0.064);
  // Sand-coloured inset panels, cut with dark cooling slots.
  for(const side of [-1,1]){
    profile(g,0.002,[[-0.236,0.024],[-0.082,0.024],[-0.052,0.007],[0.035,0.007],[0.057,-0.027],[-0.219,-0.027]],steel,side*0.043);
    profile(g,0.006,[[-0.47,0.018],[-0.305,0.026],[-0.29,-0.023],[-0.46,-0.030]],ceramic,side*0.045);
    for(let i=0;i<5;i++) block(g,0.002,0.014,0.018,recess,side*0.049,-0.002,-0.449+i*0.030,0.002);
    for(const z of [-0.253,0.063]) screw(g,side*0.044,0.004,z);
    screw(g,side*0.046,-0.013,-0.196);
    block(g,0.006,0.010,0.033,alloy,side*0.046,-0.025,0.018,0.001);
    block(g,0.002,0.005,0.044,accent,side*0.043,0.035,-0.19,0.001);
  }
  // Ejection opening, bolt cover and charging handle.
  block(g,0.003,0.026,0.092,recess,0.043,0.015,-0.075);
  block(g,0.004,0.014,0.060,steel,0.046,0.016,-0.064);
  block(g,0.027,0.012,0.017,alloy,0.060,0.034,0.025);
  magazine(g,-0.123,0.236);
  grip(g,0.062);
  stock(g,0.125,0.31);
  // Open rear notch and narrow front post preserve the existing ADS sight line.
  block(g,0.035,0.012,0.025,steel,0,0.072,0.060);
  for(const side of [-1,1]) block(g,0.006,0.018,0.012,steel,side*0.014,0.080,0.060,0.001);
  block(g,0.004,0.017,0.009,alloy,0,0.075,-0.46,0.001);
  block(g,0.002,0.004,0.002,accent,0,0.083,-0.454,0.0005);
  return g;
}

export function buildPrecisionRifle(){
  const g = new THREE.Group(); g.name='sniper';
  profile(g,0.077,[[-0.31,0.035],[0.12,0.035],[0.13,-0.05],[-0.29,-0.065]],alloy);
  profile(g,0.081,[[-0.47,0.020],[-0.31,0.034],[-0.28,-0.049],[-0.45,-0.048]],ceramic);
  tube(g,0.017,0.022,0.43,steel,0,0.005,-0.65,20);
  muzzle(g,-0.90,0.032);
  rail(g,-0.28,0.08,0.042);
  magazine(g,-0.12,0.181);
  grip(g,0.065);
  stock(g,0.13,0.35);
  // Two real mounting feet support an optic with a flared objective and eyepiece.
  for(const z of [-0.19,0.027]){
    block(g,0.046,0.033,0.035,steel,0,0.079,z);
    ring(g,0.033,0.007,alloy,0,0.12,z);
  }
  tube(g,0.030,0.030,0.27,polymer,0,0.12,-0.073,24);
  tube(g,0.030,0.049,0.09,steel,0,0.12,-0.253,24,true);
  tube(g,0.049,0.049,0.06,steel,0,0.12,-0.328,24,true);
  ring(g,0.047,0.004,alloy,0,0.12,-0.36);
  tube(g,0.042,0.042,0.001,lens,0,0.12,-0.352,24);
  tube(g,0.034,0.036,0.068,polymer,0,0.12,0.096,24);
  ring(g,0.035,0.004,alloy,0,0.12,0.131);
  tube(g,0.031,0.031,0.001,lens,0,0.12,0.132,24);
  for(let i=0;i<5;i++) ring(g,0.035,0.002,steel,0,0.12,0.064+i*0.010);
  part(g,new THREE.CylinderGeometry(0.017,0.017,0.029,16),steel,[0,0.16,-0.035]);
  part(g,new THREE.CylinderGeometry(0.019,0.019,0.008,16),alloy,[0,0.178,-0.035]);
  for(const side of [-1,1]){
    for(let i=0;i<4;i++) block(g,0.002,0.012,0.020,recess,side*0.043,-0.004,-0.43+i*0.031);
    for(const z of [-0.25,0.06]) screw(g,side*0.041,-0.008,z);
    block(g,0.002,0.004,0.045,accent,side*0.041,0.016,-0.19,0.001);
  }
  const bolt=part(g,new THREE.CylinderGeometry(0.006,0.006,0.055,10),alloy,[0.061,0.013,0.055]);
  bolt.rotation.z=Math.PI/2;
  part(g,new THREE.SphereGeometry(0.012,10,8),polymer,[0.086,0.013,0.055]);
  return g;
}
