/* OCTA 4.9 深海基地 — the 3D pieces (three.js, passed in as T): shaders, the sea itself, the domes, tubes, desks and octopuses.
   seabase.js opens the view, runs the loop and handles input; seamodel.js says what to show. Everything made here is
   reachable from the scene or listed in G.tex / G.extra, so seaFree (seaDispose) frees it all on close. */
'use strict';
/* ---------- the 3D scene ---------- */
const SEA_GLSL_FOG_V='\n#include <fog_pars_vertex>\n',SEA_GLSL_FOG_F='\n#include <fog_pars_fragment>\n';
function seaMat(T,U,o){const u=T.UniformsUtils.merge([T.UniformsLib.fog,o.uniforms||{}]);u.uTime=U.uTime;
  return new T.ShaderMaterial({uniforms:u,vertexShader:o.v,fragmentShader:o.f,transparent:o.transparent!==false,depthWrite:!!o.depthWrite,fog:true,side:o.side??T.FrontSide,blending:o.add?T.AdditiveBlending:T.NormalBlending})}
// a soft round glow (white), tinted per sprite
function seaGlowTex(T,inner){const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d'),g=x.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(inner||.25,'rgba(255,255,255,.55)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64);
  const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;return t}
// the octopus avatar as a picture for a sprite: the still pose of the state, in the bot's colour, with a soft glow
const SEA_OCT_CSS=c=>{const s=accentOf(c);return `.oa *{transform-box:view-box}.oa-legs{fill:none;stroke:${c};stroke-width:34;stroke-linecap:round}.oa-body{fill:${c}}.oa-eye{fill:#1c140a;transform-box:fill-box;transform-origin:center}.oa-shut{fill:none;stroke:#1c140a;stroke-width:11;stroke-linecap:round}.oa-star{fill:${s}}.oa-zs{fill:${c};font-family:system-ui,sans-serif;font-weight:800}.oa-dk{fill:#2e241a;stroke:${c};stroke-width:5}.oa-dm,.oa-m1,.oa-m3,.oa-ln{fill:${c}}.oa-ln{opacity:.6}.oa-scr{fill:#FFF6E0}.oa-m2{fill:#2e241a}.oa-tap{fill:none;stroke:${c};stroke-width:22;stroke-linecap:round}.oa-leg{transform-origin:var(--o)}.oa-o{transform-origin:256px 215px}.oa-z1{opacity:.95;transform:translate(10px,-22px)}.oa-z2{opacity:.65;transform:translate(28px,-56px)}.oa-z3{opacity:.35;transform:translate(42px,-82px)}.s-thinking .oa-eyes{transform:translate(10px,-14px)}.oa-o1{transform:rotate(-137deg)}.oa-o2{transform:rotate(223deg)}.oa-o3{transform:rotate(-240deg)}.oa-o4{transform:rotate(260deg)}.oa-dev-b{opacity:0}.oa-dev-f{transform:translate(var(--fx),var(--fy)) var(--r1)}.s-browsing .oa-eyes{transform:translateY(-6px)}.s-chatting .oa-eyes{transform:translate(12px,8px)}`};
function seaOctTex(G,state,color){const c=colorHex(color)||OC_DEFAULT,k=state+c;if(G.tex[k])return G.tex[k];const T=G.T;
  const cv=document.createElement('canvas');cv.width=cv.height=256;const t=new T.CanvasTexture(cv);t.colorSpace=T.SRGBColorSpace;t.anisotropy=2;G.tex[k]=t;
  const s=OA_DRAW[state]?state:'idle',svg=`<svg xmlns="http://www.w3.org/2000/svg" class="oa s-${s}" viewBox="-6 -40 524 524" width="512" height="512"><style>${SEA_OCT_CSS(c)}</style>${OA_CACHE[s]||(OA_CACHE[s]=OA_DRAW[s]())}</svg>`;
  const img=new Image();img.onload=()=>{if(!G.alive)return;const x=cv.getContext('2d');x.clearRect(0,0,256,256);x.shadowColor=c+'aa';x.shadowBlur=18;x.drawImage(img,14,14,228,228);x.shadowBlur=0;x.drawImage(img,14,14,228,228);t.needsUpdate=true;G.loop.kick()};
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);return t}
const SEA_V_GLASS=`varying vec3 vN;varying vec3 vV;varying vec3 vW;${SEA_GLSL_FOG_V}
void main(){vec4 wp=modelMatrix*vec4(position,1.);vW=wp.xyz;vec4 mvPosition=viewMatrix*wp;vN=normalize(normalMatrix*normal);vV=normalize(-mvPosition.xyz);gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`;
const SEA_F_GLASS=`uniform vec3 uRim;uniform float uTime;uniform float uBase;uniform float uLines;varying vec3 vN;varying vec3 vV;varying vec3 vW;${SEA_GLSL_FOG_F}
void main(){vec3 n=normalize(vN);float f=pow(1.-abs(dot(n,normalize(vV))),2.4);
float ln=uLines*(1.-smoothstep(0.,.05,abs(fract(vW.y*1.25-uTime*.04)-.5)-.44));
float sp=pow(max(dot(reflect(-normalize(vV),n),normalize(vec3(-.35,.8,.45))),0.),40.);
vec3 c=uRim*(f*1.5+ln*.6)+vec3(.85,.97,1.)*sp*.8;float a=uBase+f*.7+ln*.09+sp*.5;gl_FragColor=vec4(c,clamp(a,0.,1.));
#include <fog_fragment>
}`;
function seaGlass(T,U,rim,base,lines){return seaMat(T,U,{uniforms:{uRim:{value:new T.Color(rim)},uBase:{value:base??.05},uLines:{value:lines??1}},v:SEA_V_GLASS,f:SEA_F_GLASS})}


/* the sea itself: floor with moving caustics, rocks, kelp, glowing coral, light shafts from above, drifting snow, bubbles, fish */
function seaEnv(G){const T=G.T,U=G.U,grp=new T.Group();G.extra=[];
  // a dome of water: brighter where the light comes from
  const sky=new T.Mesh(new T.SphereGeometry(240,32,16),new T.ShaderMaterial({side:T.BackSide,depthWrite:false,fog:false,uniforms:{},
    vertexShader:'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'varying vec3 vP;void main(){float h=normalize(vP).y;vec3 c=mix(vec3(.008,.05,.08),vec3(.03,.24,.32),smoothstep(-.1,.9,h));c+=vec3(.05,.22,.25)*pow(max(h,0.),6.);gl_FragColor=vec4(c,1.);}'}));
  sky.renderOrder=-1;grp.add(sky);
  // the floor: flat where the base stands, dunes and ridges further out
  const fg=new T.PlaneGeometry(320,320,96,96);fg.rotateX(-Math.PI/2);const pos=fg.attributes.position;
  const span=(SEA.L?.span||26)+6;
  for(let i=0;i<pos.count;i++){const x=pos.getX(i),z=pos.getZ(i),d=Math.hypot(x,z),k=Math.max(0,Math.min(1,(d-span)/40));
    const n=Math.sin(x*.11)*Math.cos(z*.13)*1.6+Math.sin(x*.031+z*.04)*3.2+Math.sin(z*.27+x*.05)*.5;pos.setY(i,-.02+k*k*(n+4+k*6)+(1-k)*Math.sin(x*.4)*Math.cos(z*.37)*.06)}
  fg.computeVertexNormals();
  const fm=new T.MeshStandardMaterial({color:0x1d4448,roughness:.95,metalness:0,flatShading:true});
  fm.onBeforeCompile=sh=>{sh.uniforms.uTime=U.uTime;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vWp;').replace('#include <begin_vertex>','#include <begin_vertex>\nvWp=(modelMatrix*vec4(position,1.)).xyz;');
    sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
uniform float uTime;varying vec3 vWp;
float seaCaus(vec2 p,float t){vec2 q=p+vec2(sin(p.y*1.3+t),cos(p.x*1.1-t*.8))*.6;float v=sin(q.x*2.1+t)*sin(q.y*2.3-t*.7);
vec2 r=p*1.7+vec2(cos(p.y*.9-t*.6),sin(p.x*1.4+t*.5))*.8;v+=sin(r.x*1.9-t*.4)*sin(r.y*2.-t*.9)*.8;return pow(max(0.,1.-abs(v)*1.4),4.);}`)
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\nfloat cz=seaCaus(vWp.xz*.55,uTime*.5)*.7+seaCaus(vWp.xz*.31+3.1,uTime*.38)*.45;totalEmissiveRadiance+=vec3(.3,.78,.82)*cz*.075*(1.-smoothstep(14.,46.,length(vWp.xz)));')};
  const floor=new T.Mesh(fg,fm);grp.add(floor);
  // a soft lit disc under the base, like work lights on the sand
  const pad=new T.Mesh(new T.CircleGeometry(span+4,64).rotateX(-Math.PI/2),new T.MeshBasicMaterial({map:G.glow,color:0x1f8a96,transparent:true,opacity:.28,depthWrite:false,blending:T.AdditiveBlending}));pad.position.y=.03;grp.add(pad);
  const rnd=seaRand(7);
  // rocks
  const rockG=new T.DodecahedronGeometry(1,0),rockM=new T.MeshStandardMaterial({color:0x24525a,roughness:1,flatShading:true});
  const rocks=new T.InstancedMesh(rockG,rockM,46),M=new T.Matrix4(),Q=new T.Quaternion(),E=new T.Euler(),V=new T.Vector3(),Sc=new T.Vector3();
  for(let i=0;i<46;i++){const a=rnd()*Math.PI*2,d=span+3+rnd()*42,s=.5+rnd()*rnd()*3.2;E.set(rnd()*3,rnd()*3,rnd()*3);Q.setFromEuler(E);
    V.set(Math.cos(a)*d,s*.3,Math.sin(a)*d);Sc.set(s*(1+rnd()*.6),s*(.5+rnd()*.5),s);M.compose(V,Q,Sc);rocks.setMatrixAt(i,M)}
  grp.add(rocks);
  // coral: bioluminescent fans and knobs
  const corG=new T.ConeGeometry(.35,1.4,5,1),corM=new T.MeshBasicMaterial({color:0xffffff}),cn=70,coral=new T.InstancedMesh(corG,corM,cn),C=new T.Color();
  const CC=[0xff6fae,0xb07cff,0x4ff0e0,0xffa860,0x7dffb2];
  for(let i=0;i<cn;i++){const cl=Math.floor(i/7),a=(cl*.97+rnd()*.12)*Math.PI*2/1.0,d=span+2+((cl*13)%9)*2.1+rnd()*2,s=.4+rnd()*.9;
    E.set((rnd()-.5)*.9,rnd()*6,(rnd()-.5)*.9);Q.setFromEuler(E);V.set(Math.cos(a)*d+(rnd()-.5)*2.4,s*.55,Math.sin(a)*d+(rnd()-.5)*2.4);Sc.set(s,s*(1+rnd()),s);M.compose(V,Q,Sc);coral.setMatrixAt(i,M);
    C.setHex(CC[cl%CC.length]).multiplyScalar(.55+rnd()*.5);coral.setColorAt(i,C)}
  grp.add(coral);
  // glowing anemones among the coral
  for(let i=0;i<16;i++){const a=rnd()*Math.PI*2,d=span+2+rnd()*16,sp=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:CC[i%CC.length],transparent:true,opacity:.65,depthWrite:false,blending:T.AdditiveBlending}));
    sp.position.set(Math.cos(a)*d,.5+rnd()*.5,Math.sin(a)*d);const s=1+rnd()*1.6;sp.scale.set(s,s,1);sp.userData.pulse=rnd()*6;grp.add(sp);(G.pulses||(G.pulses=[])).push(sp)}
  // kelp: one mesh, every strand sways in the shader
  const kp=[],kh=[],ks=[],ki=[];let vi=0;
  for(let c=0;c<11;c++){const ca=c/11*Math.PI*2+rnd()*.4,cd=span+5+rnd()*20,cx=Math.cos(ca)*cd,cz=Math.sin(ca)*cd,n=4+Math.floor(rnd()*5);
    for(let s=0;s<n;s++){const x0=cx+(rnd()-.5)*4,z0=cz+(rnd()-.5)*4,h=5+rnd()*9,w=.35+rnd()*.3,yaw=rnd()*Math.PI,seg=10,sd=rnd();
      for(let j=0;j<=seg;j++){const f=j/seg,ww=w*(1-f*.65),dx=Math.cos(yaw)*ww,dz=Math.sin(yaw)*ww;
        kp.push(x0-dx,f*h,z0-dz,x0+dx,f*h,z0+dz);kh.push(f,f);ks.push(sd,sd);
        if(j<seg)ki.push(vi,vi+1,vi+2,vi+1,vi+3,vi+2);vi+=2}}}
  const kg=new T.BufferGeometry();kg.setAttribute('position',new T.Float32BufferAttribute(kp,3));kg.setAttribute('aH',new T.Float32BufferAttribute(kh,1));kg.setAttribute('aS',new T.Float32BufferAttribute(ks,1));kg.setIndex(ki);
  const kelp=new T.Mesh(kg,seaMat(T,U,{transparent:false,depthWrite:true,side:T.DoubleSide,
    v:`attribute float aH;attribute float aS;uniform float uTime;varying float vH;${SEA_GLSL_FOG_V}
void main(){vec3 p=position;float k=aH*aH;p.x+=sin(uTime*.7+aS*6.28+aH*2.2)*k*1.1;p.z+=cos(uTime*.55+aS*4.+aH*1.7)*k*.8;vH=aH;vec4 mvPosition=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    f:`varying float vH;${SEA_GLSL_FOG_F}
void main(){vec3 c=mix(vec3(.02,.09,.07),vec3(.08,.42,.3),vH);c+=vec3(.2,.9,.7)*smoothstep(.86,1.,vH)*.5;gl_FragColor=vec4(c,1.);
#include <fog_fragment>
}`}));
  grp.add(kelp);
  // light shafts from the surface (turned to face the camera every frame)
  const rayM=seaMat(T,U,{add:true,side:T.DoubleSide,uniforms:{uSeed:{value:0}},
    v:`varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    f:`uniform float uTime;uniform float uSeed;varying vec2 vU;void main(){float e=smoothstep(0.,.45,vU.x)*smoothstep(1.,.55,vU.x);float h=smoothstep(0.,.75,vU.y)*smoothstep(1.,.88,vU.y);
float fl=.55+.45*sin(uTime*.5+uSeed*7.+vU.y*3.);gl_FragColor=vec4(vec3(.45,.9,1.)*e*e*h*fl*.12,1.);}`});
  rayM.fog=false;G.rays=[];
  for(let i=0;i<7;i++){const m=rayM.clone();m.uniforms.uTime=U.uTime;m.uniforms.uSeed={value:rnd()*10};const w=5+rnd()*7,h=50;
    const ray=new T.Mesh(new T.PlaneGeometry(w,h),m);const a=rnd()*Math.PI*2,d=4+rnd()*(span+6);ray.position.set(Math.cos(a)*d,h/2-2,Math.sin(a)*d);ray.userData.tilt=(rnd()-.5)*.35;grp.add(ray);G.rays.push(ray)}
  G.extra.push(rayM);
  // drifting snow and rising bubbles: the shader moves them, the CPU does nothing
  const pts=(n,box,f)=>{const g=new T.BufferGeometry(),p=new Float32Array(n*3),s=new Float32Array(n);for(let i=0;i<n;i++){const [x,y,z]=f(i);p[i*3]=x;p[i*3+1]=y;p[i*3+2]=z;s[i]=rnd()}
    g.setAttribute('position',new T.BufferAttribute(p,3));g.setAttribute('aS',new T.BufferAttribute(s,1));return g};
  const snowM=seaMat(T,U,{uniforms:{uPR:{value:G.r.getPixelRatio()}},
    v:`attribute float aS;uniform float uTime;uniform float uPR;varying float vA;${SEA_GLSL_FOG_V}
void main(){vec3 p=position;p.y=mod(p.y-uTime*(.12+aS*.22),26.)-1.;p.x+=sin(uTime*.25+aS*30.)*.8;p.z+=cos(uTime*.2+aS*17.)*.8;vec4 mvPosition=modelViewMatrix*vec4(p,1.);
gl_PointSize=(1.2+aS*2.6)*uPR*(60./max(1.,-mvPosition.z));vA=(.25+.55*aS)*smoothstep(-1.,2.,p.y);gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    f:`varying float vA;${SEA_GLSL_FOG_F}
void main(){float d=length(gl_PointCoord-.5);float a=smoothstep(.5,.0,d)*vA;gl_FragColor=vec4(.78,.96,1.,a);
#include <fog_fragment>
}`});
  const snow=new T.Points(pts(600,0,()=>[(rnd()-.5)*110,rnd()*26,(rnd()-.5)*110]),snowM);grp.add(snow);G.snowM=snowM;
  const bubM=seaMat(T,U,{uniforms:{uPR:{value:G.r.getPixelRatio()}},
    v:`attribute float aS;uniform float uTime;uniform float uPR;varying float vA;${SEA_GLSL_FOG_V}
void main(){vec3 p=position;float y=mod(uTime*(.9+aS*.9)+aS*30.,22.);p.y+=y;p.x+=sin(y*1.7+aS*9.)*.25;p.z+=cos(y*1.3+aS*5.)*.25;vec4 mvPosition=modelViewMatrix*vec4(p,1.);
gl_PointSize=(2.+aS*4.)*uPR*(60./max(1.,-mvPosition.z));vA=smoothstep(22.,14.,y)*.8;gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    f:`varying float vA;${SEA_GLSL_FOG_F}
void main(){vec2 q=gl_PointCoord-.5;float d=length(q);float ring=smoothstep(.5,.42,d)*smoothstep(.24,.4,d);float hi=smoothstep(.16,.0,length(q-vec2(-.14,-.14)));
gl_FragColor=vec4(vec3(.75,.97,1.),(ring*.75+hi*.9)*vA);
#include <fog_fragment>
}`});
  const vents=[];for(let i=0;i<9;i++){const a=rnd()*Math.PI*2,d=span+2+rnd()*12;vents.push([Math.cos(a)*d,Math.sin(a)*d])}
  const bub=new T.Points(pts(180,0,i=>{const v=vents[i%vents.length];return [v[0]+(rnd()-.5)*.8,0,v[1]+(rnd()-.5)*.8]}),bubM);grp.add(bub);G.bubM=bubM;
  // jellyfish drifting in the dark above, glowing softly
  const jc=document.createElement('canvas');jc.width=jc.height=128;const jx=jc.getContext('2d');
  const bg=jx.createRadialGradient(64,46,4,64,50,40);bg.addColorStop(0,'rgba(255,255,255,.95)');bg.addColorStop(.6,'rgba(255,255,255,.45)');bg.addColorStop(1,'rgba(255,255,255,0)');
  jx.fillStyle=bg;jx.beginPath();jx.ellipse(64,52,34,26,0,Math.PI,0);jx.quadraticCurveTo(64,64,30,52);jx.fill();
  jx.strokeStyle='rgba(255,255,255,.55)';jx.lineWidth=2.2;jx.lineCap='round';
  for(let i=0;i<6;i++){const x=40+i*9.5;jx.beginPath();jx.moveTo(x,56);jx.bezierCurveTo(x-6,76,x+6,92,x-2,118-(i%2)*12);jx.stroke()}
  const jt=new T.CanvasTexture(jc);jt.colorSpace=T.SRGBColorSpace;G.extra.push(jt);G.jelly=[];
  for(let i=0;i<6;i++){const a=rnd()*Math.PI*2,d=span*.6+rnd()*span*.9,col=[0xff8fd0,0x8ff7ff,0xb9a3ff][i%3];
    const j=new T.Sprite(new T.SpriteMaterial({map:jt,color:col,transparent:true,opacity:.55,depthWrite:false,blending:T.AdditiveBlending,fog:true}));
    const sz=1.6+rnd()*1.8;j.scale.set(sz,sz,1);j.position.set(Math.cos(a)*d,9+rnd()*9,Math.sin(a)*d);j.userData={y:j.position.y,ph:rnd()*6,sz};grp.add(j);G.jelly.push(j)}
  // a school of little fish circling far out
  const fishG=new T.ConeGeometry(.16,.7,4,1).rotateZ(-Math.PI/2),fish=new T.InstancedMesh(fishG,new T.MeshBasicMaterial({color:0x7fd8e8}),36);
  fish.userData.seed=[...Array(36)].map(()=>[rnd(),rnd(),rnd()]);fish.frustumCulled=false;grp.add(fish);G.fish=fish;
  return grp}
function seaRand(s){return ()=>{s=(s*16807)%2147483647;return (s-1)/2147483646}}

/* the base: domes, tubes, desks, octopuses. Rebuilt when modules or bots come and go; states update in place */
function seaSync(){const G=SEA.g,m=SEA.m,L=SEA.L;if(!G||!m)return;
  const ssig=JSON.stringify([m.pods.map(p=>[p.id,p.name,p.bots]),m.rooms.map(r=>[r.id,r.pod,r.name])]);
  if(ssig!==SEA.ssig){SEA.ssig=ssig;seaBuild(G,m,L)}
  for(const b of m.bots)seaBotState(G,b,m,L);
  G.loop.kick(2)}
function seaBuild(G,m,L){const T=G.T,U=G.U;
  if(G.base){G.scene.remove(G.base);seaDispose(G.base)}
  for(const id in G.labels)G.labels[id].el.remove();G.labels={};const keep=G.bots;G.bots={};G.pick=[];
  const base=new T.Group();G.base=base;G.scene.add(base);
  const metal=new T.MeshStandardMaterial({color:0x2a5568,roughness:.45,metalness:.6}),dark=new T.MeshStandardMaterial({color:0x0f2632,roughness:.6,metalness:.5});
  const floorM=new T.MeshStandardMaterial({color:0x1d4656,roughness:.6,metalness:.25});
  const dome=(x,z,r,col,id,kind)=>{const g=new T.Group();g.position.set(x,0,z);
    const plat=new T.Mesh(new T.CylinderGeometry(r+.35,r+.75,.5,48),metal);plat.position.y=.25;g.add(plat);
    const fl=new T.Mesh(new T.CircleGeometry(r+.2,48).rotateX(-Math.PI/2),floorM);fl.position.y=.505;g.add(fl);
    const ringM=new T.MeshBasicMaterial({color:col,toneMapped:false});
    const ring=new T.Mesh(new T.TorusGeometry(r+.42,.055,6,96).rotateX(Math.PI/2),ringM);ring.position.y=.52;g.add(ring);
    const inner=new T.Mesh(new T.RingGeometry(r*.32,r*.32+.05,64).rotateX(-Math.PI/2),new T.MeshBasicMaterial({color:col,transparent:true,opacity:.35,toneMapped:false}));inner.position.y=.51;g.add(inner);
    const gl=new T.Mesh(new T.SphereGeometry(r+.36,48,20,0,Math.PI*2,0,Math.PI/2),seaGlass(T,U,col,.035,1));gl.position.y=.5;gl.renderOrder=2;gl.userData[kind]=id;g.add(gl);G.pick.push(gl);
    const ribM=new T.MeshStandardMaterial({color:0x2a5566,roughness:.4,metalness:.7,emissive:new T.Color(col),emissiveIntensity:.08});
    for(let i=0;i<3;i++){const rib=new T.Mesh(new T.TorusGeometry(r+.37,.045,5,40,Math.PI),ribM);rib.rotation.y=i*Math.PI/3;rib.position.y=.5;g.add(rib)}
    const cap=new T.Mesh(new T.CylinderGeometry(.35,.5,.35,12),dark);cap.position.y=.5+r+.45;g.add(cap);
    const bc=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));bc.position.y=.5+r+.85;bc.scale.set(1.4,1.4,1);bc.userData.pulse=x*.3;g.add(bc);(G.pulses2||(G.pulses2=[])).push(bc);
    for(let i=0;i<8;i++){const a=i/8*Math.PI*2,l=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,opacity:.7,depthWrite:false,blending:T.AdditiveBlending}));l.position.set(Math.cos(a)*(r+.6),.32,Math.sin(a)*(r+.6));l.scale.set(.55,.55,1);g.add(l)}
    base.add(g);return g};
  G.pulses2=[];
  for(const p of m.pods){const c=L.pods[p.id];const g=dome(c.x,c.z,c.r,p.color,p.id,'pod');
    if(p.id==='hub'){// the hub's tower: through the dome, rings of light up to a beacon
      const tw=new T.Mesh(new T.CylinderGeometry(.42,.6,c.r+9,16),metal);tw.position.y=(c.r+9)/2+.5;g.add(tw);
      for(let i=0;i<4;i++){const rg=new T.Mesh(new T.TorusGeometry(.95-i*.08,.05,6,40).rotateX(Math.PI/2),new T.MeshBasicMaterial({color:p.color,toneMapped:false}));rg.position.y=c.r+2.4+i*1.7;rg.userData.spin=i;g.add(rg);(G.spin||(G.spin=[])).push(rg)}
      const top=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:0x9ff7ff,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));top.position.y=c.r+10;top.scale.set(3,3,1);g.add(top);G.pulses2.push(top);
      const holo=new T.Mesh(new T.CylinderGeometry(.9,1.25,.3,24),dark);holo.position.y=.65;g.add(holo)}
    seaLabel(G,'p:'+p.id,{x:c.x,y:0,z:c.z,r:c.r+.9},`<b data-u>${esc(seaPodName(p))}</b><small><span>深度</span> <span data-u>${p.depth}m</span></small>`,'sea-pl',p.color)}
  for(const r of m.rooms){const c=L.rooms[r.id],p=m.pods.find(x=>x.id===r.pod);const g=dome(c.x,c.z,c.r,p.color,r.id,'room');
    const tb=new T.Mesh(new T.CylinderGeometry(1,1,.08,32),new T.MeshStandardMaterial({color:0x24495a,roughness:.3,metalness:.6}));tb.position.y=1.15;g.add(tb);
    const leg=new T.Mesh(new T.CylinderGeometry(.18,.3,.6,10),dark);leg.position.y=.82;g.add(leg);
    const holo=new T.Mesh(new T.ConeGeometry(.75,1.3,24,1,true),new T.MeshBasicMaterial({color:p.color,transparent:true,opacity:.16,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,toneMapped:false}));holo.rotation.x=Math.PI;holo.position.y=1.85;g.add(holo);G.holos=(G.holos||[]);G.holos.push(holo);
    seaLabel(G,'r:'+r.id,{x:c.x,y:0,z:c.z,r:c.r+.9},`<small><span>會議室</span></small><b data-u>${esc(r.name)}</b>`,'sea-pl room',p.color)}
  // tubes: the hub to each module, each module to its meeting rooms; light pulses run along them
  G.tubes=[];const glassT=seaGlass(T,U,0x6ff3ff,.03,0),collarM=new T.MeshStandardMaterial({color:0x2c5a6b,roughness:.4,metalness:.7,emissive:new T.Color(0x2fd8e6),emissiveIntensity:.25});
  const tube=(a,b,ra,rb,col,key)=>{const dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz)||1,ux=dx/l,uz=dz/l;
    const p0=new T.Vector3(a.x+ux*(ra+.1),1.1,a.z+uz*(ra+.1)),p1=new T.Vector3(b.x-ux*(rb+.1),1.1,b.z-uz*(rb+.1)),mid=p0.clone().lerp(p1,.5);mid.y=1.7;
    const curve=new T.CatmullRomCurve3([p0,mid,p1]),tg=new T.TubeGeometry(curve,32,.62,14,false),mesh=new T.Mesh(tg,glassT);mesh.renderOrder=3;base.add(mesh);
    const walk=new T.Mesh(new T.TubeGeometry(curve,24,.16,6,false),dark);walk.position.y=-.52;base.add(walk);
    const len=curve.getLength(),nc=Math.max(2,Math.floor(len/2.4)),col2=new T.InstancedMesh(new T.TorusGeometry(.66,.06,6,24),collarM,nc),M=new T.Matrix4(),Q=new T.Quaternion(),Z=new T.Vector3(0,0,1),V1=new T.Vector3(1,1,1);
    for(let i=0;i<nc;i++){const t=(i+.5)/nc,p=curve.getPointAt(t),tan=curve.getTangentAt(t);Q.setFromUnitVectors(Z,tan);M.compose(p,Q,V1);col2.setMatrixAt(i,M)}base.add(col2);
    const pulses=[];for(let i=0;i<2;i++){const s=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));s.scale.set(.9,.9,1);base.add(s);pulses.push(s)}
    G.tubes.push({key,curve,len,pulses,hot:0})};
  for(const p of m.pods.slice(1)){const a=L.pods.hub,b=L.pods[p.id];tube(a,b,a.r+.4,b.r+.4,p.color,'hub>'+p.id)}
  for(const r of m.rooms){const a=L.pods[r.pod],b=L.rooms[r.id];tube(a,b,a.r+.4,b.r+.4,m.pods.find(x=>x.id===r.pod).color,r.pod+'>'+r.id)}
  // desks: one mesh each for tops, monitors, screens and stools (instanced)
  const ids=m.bots.map(b=>b.id),n=Math.max(1,ids.length);
  const top=new T.InstancedMesh(new T.BoxGeometry(1.35,.07,.66),new T.MeshStandardMaterial({color:0x5d8fa0,roughness:.35,metalness:.3}),n);
  const legs=new T.InstancedMesh(new T.BoxGeometry(1.15,.62,.06),dark,n);
  const mon=new T.InstancedMesh(new T.BoxGeometry(.86,.52,.05),new T.MeshStandardMaterial({color:0x10242e,roughness:.4,metalness:.4,emissive:new T.Color(0x1a5566),emissiveIntensity:.5}),n);
  const scr=new T.InstancedMesh(new T.PlaneGeometry(.78,.44),new T.MeshBasicMaterial({color:0xffffff,toneMapped:false}),n);
  const stool=new T.InstancedMesh(new T.CylinderGeometry(.32,.38,.42,14),metal,n);
  const M=new T.Matrix4(),Q=new T.Quaternion(),V=new T.Vector3(),one=new T.Vector3(1,1,1),Y=new T.Vector3(0,1,0),C=new T.Color(0x0e2a3a);
  ids.forEach((id,i)=>{const d=L.desks[id],dx=Math.cos(d.face),dz=Math.sin(d.face),ry=-d.face+Math.PI/2;Q.setFromAxisAngle(Y,ry);
    V.set(d.x+dx*.95,1.22,d.z+dz*.95);M.compose(V,Q,one);top.setMatrixAt(i,M);
    V.set(d.x+dx*.95,.86,d.z+dz*.95);M.compose(V,Q,one);legs.setMatrixAt(i,M);
    V.set(d.x+dx*1.15,1.56,d.z+dz*1.15);M.compose(V,Q,one);mon.setMatrixAt(i,M);
    const qs=new T.Quaternion().setFromAxisAngle(Y,ry+Math.PI);V.set(d.x+dx*1.12,1.56,d.z+dz*1.12);M.compose(V,qs,one);scr.setMatrixAt(i,M);scr.setColorAt(i,C);
    V.set(d.x,.71,d.z);M.compose(V,Q,one);stool.setMatrixAt(i,M)});
  base.add(top,legs,mon,scr,stool);G.scr=scr;G.deskIdx=Object.fromEntries(ids.map((id,i)=>[id,i]));
  // the octopuses
  const shadowM=new T.MeshBasicMaterial({map:G.glow,color:0x000000,transparent:true,opacity:.5,depthWrite:false});G.extra.push(shadowM);
  for(const b of m.bots){const old=keep[b.id],sp=new T.Sprite(new T.SpriteMaterial({map:seaOctTex(G,b.state,b.color),transparent:true,depthWrite:true,alphaTest:.12,fog:false,toneMapped:false}));
    sp.center.set(.5,.1);sp.scale.set(SEA_OCT,SEA_OCT,1);sp.userData.bot=b.id;sp.renderOrder=5;base.add(sp);G.pick.push(sp);
    const sh=new T.Mesh(new T.PlaneGeometry(1.4,1.4).rotateX(-Math.PI/2),shadowM);base.add(sh);
    const halo=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:new T.Color(colorHex(b.color)||OC_DEFAULT),transparent:true,opacity:.3,depthWrite:false,blending:T.AdditiveBlending}));halo.scale.set(2.6,2.6,1);base.add(halo);
    const e={sp,sh,halo,beam:null,ph:Math.random()*6,pos:old?old.pos:null,route:null,s:0,node:null,state:''};G.bots[b.id]=e;
    seaLabel(G,'b:'+b.id,null,'','sea-bt',colorHex(b.color)||OC_DEFAULT)}}
// what a bot looks like now: its pose, screen, beacon, bubble — and where it should be (it swims there through the tubes)
function seaBotState(G,b,m,L){const T=G.T,e=G.bots[b.id];if(!e)return;
  const pose=b.need&&b.state==='idle'?'working':b.state;   // waiting for you: awake, not dozing
  if(e.state!==pose+b.color){e.state=pose+b.color;e.sp.material.map=seaOctTex(G,pose,b.color);e.sp.material.needsUpdate=true}
  e.sp.material.color.set(b.paused?0x8a99a3:0xffffff);
  const tone=b.need?'need':b.fail?'fail':'';
  if(tone&&!e.beam){const col=tone==='need'?0xffb547:0xff4d4d,g=new T.Group();
    const beam=new T.Mesh(new T.CylinderGeometry(.22,.55,7,16,1,true),new T.MeshBasicMaterial({color:col,transparent:true,opacity:.3,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,toneMapped:false}));beam.position.y=4.6;g.add(beam);
    const ring=new T.Mesh(new T.RingGeometry(.7,.86,40).rotateX(-Math.PI/2),new T.MeshBasicMaterial({color:col,transparent:true,opacity:.8,blending:T.AdditiveBlending,depthWrite:false,toneMapped:false}));ring.position.y=.55;g.add(ring);
    const lamp=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));lamp.position.y=2.45;lamp.scale.set(1.5,1.5,1);g.add(lamp);
    g.userData={beam,ring,lamp,tone};G.base.add(g);e.beam=g}
  if(e.beam&&e.beam.userData.tone!==tone){G.base.remove(e.beam);seaDispose(e.beam);e.beam=null;if(tone)return seaBotState(G,b,m,L)}
  const spot=seaSpot(m,L,b);
  if(!e.pos){e.pos={x:spot.x,z:spot.z};e.node=spot.node}
  else if(Math.hypot(spot.x-(e.goal?.x??e.pos.x),spot.z-(e.goal?.z??e.pos.z))>.05){
    if(seaStill()){e.pos={x:spot.x,z:spot.z};e.route=null}
    else{const pts=seaRoute(L,e.node||spot.node,spot.node,{x:e.pos.x,z:e.pos.z},spot);e.route=seaPath(pts);e.s=0}
    e.node=spot.node}
  e.goal={x:spot.x,z:spot.z};e.b=b;
  // the label: a name tag, and a bubble when there is something to say
  const lb=G.labels['b:'+b.id];if(lb){const bb=b.bubble;
    const h=`${bb&&(bb.lab||bb.txt)?`<div class="sea-bub ${bb.tone}">${bb.lab?`<b>${esc(bb.lab)}</b>`:''}${bb.txt?`<span data-u>${esc(bb.txt)}</span>`:''}</div>`:''}<div class="sea-nm"><i></i><span data-u>${esc(b.name)}</span></div>`;
    if(lb.h!==h){lb.h=h;setHTML(lb.el,h);lb.w=0;lb.fw=0}const tc='t-'+(bb?.tone||'none');if(lb.tc!==tc){if(lb.tc)lb.el.classList.remove(lb.tc);lb.el.classList.add(tc);lb.tc=tc}}}
function seaPath(pts){const seg=[];let len=0;for(let i=1;i<pts.length;i++){const l=Math.hypot(pts[i].x-pts[i-1].x,pts[i].z-pts[i-1].z);seg.push(l);len+=l}return {pts,seg,len}}
function seaAlong(r,s){let d=s*r.len;for(let i=0;i<r.seg.length;i++){if(d<=r.seg[i]||i===r.seg.length-1){const k=r.seg[i]?Math.min(1,d/r.seg[i]):1,a=r.pts[i],b=r.pts[i+1];return {x:a.x+(b.x-a.x)*k,z:a.z+(b.z-a.z)*k}}d-=r.seg[i]}return r.pts[r.pts.length-1]}
function seaLabel(G,key,at,html,cls,col){const el=document.createElement('div');el.className='sea-tag '+cls;el.style.setProperty('--c',col);if(html)setHTML(el,html);$('seaTags').appendChild(el);
  G.labels[key]={el,at,h:html,x:-1e4,y:-1e4,w:0,vis:true}}
