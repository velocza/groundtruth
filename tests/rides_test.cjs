const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const ctx={atob:s=>Buffer.from(s,'base64').toString('binary')}; ctx.window=ctx;
vm.createContext(ctx);
const AREA=process.argv[2]==='sf'?'data_sf':'data';   // node tests/rides_test.cjs sf  checks the San Francisco file
vm.runInContext(fs.readFileSync(path.join(root,'site',AREA,'census_bg.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'site/js/rides.js'),'utf8'),ctx);
const R=ctx.GTRides,C=ctx.GT_CENSUS,D=R.decode(C);
const J=x=>JSON.parse(JSON.stringify(x));   // results come from another realm

/* the generated Census file */
assert.equal(C.meta.year,2024); assert.ok(/2020 to 2024/.test(C.meta.vintage));
assert.equal(D.n,C.meta.buildings.packed); assert.equal(D.cells.length,480*456);
assert.ok(D.bg.every(g=>g.hh.length===2&&g.nocar[1]>=0&&g.frac>=0&&g.frac<=1));
{let same=0,n=0; for(let i=0;i<D.n;i+=7){n++; if(R.bgAt(D,D.lon[i],D.lat[i])===D.bldBg[i]) same++;} assert.ok(same/n>0.97,'the click raster and the building assignment agree: '+same/n);}

/* spreading: per-building shares add back up to each block group, low <= estimate <= high */
{const sp=R.spread(D),tot=new Float64Array(D.bg.length); for(let i=0;i<D.n;i++){tot[D.bldBg[i]]+=sp.est[i]; assert.ok(sp.lo[i]<=sp.est[i]&&sp.est[i]<=sp.hi[i]);}
 D.bg.forEach((g,k)=>{ if(g.n) assert.ok(Math.abs(tot[k]-g.hh[0]*g.frac)<0.01*Math.max(1,g.hh[0]),g.id); });}

/* simulated households: same seed, same households; another seed, different ones */
const hh=R.households(D),hh2=R.households(D),hh3=R.households(D,7);
assert.equal(hh.n,hh2.n); assert.deepEqual(Array.from(hh.bld),Array.from(hh2.bld)); assert.deepEqual(Array.from(hh.uCar),Array.from(hh2.uCar)); assert.deepEqual(Array.from(hh.size),Array.from(hh2.size));
assert.notDeepEqual(Array.from(hh.uCar.slice(0,50)),Array.from(hh3.uCar.slice(0,50)));
{const per=new Float64Array(D.bg.length); for(let h=0;h<hh.n;h++) per[D.bldBg[hh.bld[h]]]++;
 D.bg.forEach((g,k)=>{ if(g.n) assert.equal(per[k],Math.round(g.hh[0]*g.frac),'households in '+g.id); });
 const need=[0,1,2].map(l=>R.needs(D,hh,l)),nocar=need.map(a=>Array.from(a).filter(v=>v&1).length),want=D.bg.reduce((a,g)=>a+(g.n?g.nocar[0]*g.frac:0),0);
 assert.ok(Math.abs(nocar[1]-want)<0.08*want,`no-car households ${nocar[1]} against the Census ${want.toFixed(0)}`);
 assert.ok(nocar[0]<=nocar[1]&&nocar[1]<=nocar[2]);
 for(let h=0;h<hh.n;h++){ assert.ok((need[0][h]&need[1][h])===need[0][h]&&(need[1][h]&need[2][h])===need[1][h]); if(need[2][h]&2) assert.equal(hh.size[h],1); }}

/* a hand-built street: buildings 0..5 along one road that runs east to the exit at node 0 (node k is k x 200 m from the exit); building 6 sits on a side road */
const T={bg:[{id:'t',frac:1,hh:[7,0],nocar:[0,0],alone65:[0,0],age65:[0,0],age75:[0,0],sizes:[7,0,0,0,0,0,0],n:7}],n:7,lon:Float64Array.from([0,1,2,3,4,5,6],k=>-122+k*200/87800),lat:new Float64Array(7).fill(37.9),area:new Uint16Array(7).fill(100),bldBg:new Uint8Array(7),bbox:[-123,37,-121,38],NX:10,NY:10,cells:new Uint8Array(100)};
const H=(sizes)=>({n:sizes.length,bld:Int32Array.from(sizes,(_,k)=>k),size:Uint8Array.from(sizes),uCar:new Float32Array(sizes.length),uHelp:new Float32Array(sizes.length)});
const line=(blocked)=>{ // nodes 0..5 on the main road, node 6 hangs off node 3 by a 300 m side road
  const edges=[[1,0,200],[2,1,200],[3,2,200],[4,3,200],[5,4,200],[6,3,300]].filter(e=>!(blocked||[]).some(b=>b[0]===e[0]&&b[1]===e[1]));
  const next=new Int32Array(7).fill(-2),dist=new Float32Array(7); next[0]=-1; let ch=true; while(ch){ch=false; for(const [a,b,l] of edges) if(next[a]===-2&&next[b]!==-2){next[a]=b;dist[a]=dist[b]+l;ch=true;}}
  return {nodeOf:Int32Array.from([0,1,2,3,4,5,6]),next,dist,adj:n=>edges.filter(e=>e[0]===n||e[1]===n).map(e=>[e[0]===n?e[1]:e[0],e[2]])};
};
/* four-way split */
{const need=Uint8Array.from([0,0,1,2,0,3,0]),zone=Uint8Array.from([0,1,1,1,1,1,1]),clear=Uint8Array.from([1,1,1,1,0,0,1]);
 assert.deepEqual(Array.from(R.split(H([1,1,1,1,1,1,1]),need,zone,clear)),[1,2,3,3,4,4,2]);}
/* blocked routes go to group 4 and never into matching, even with a car next door */
{const net=line([[4,3]]),zone=new Uint8Array(7).fill(1),clear=Uint8Array.from(net.next,v=>v!==-2?1:0);
 assert.deepEqual(Array.from(clear),[1,1,1,1,0,0,1]);
 const g=R.split(H([1,1,1,1,1,1,1]),Uint8Array.from([0,0,0,0,1,0,0]),zone,clear); assert.equal(g[4],4); assert.equal(g[5],4);
 const m=R.match([{id:4,node:4,seats:1}],[{id:5,node:5,seats:4},{id:3,node:3,seats:4}],net); assert.equal(m.pairs.length,0); assert.deepEqual(J(m.left),[4]);}
/* a driver further up the road passes the rider: no detour */
{const m=R.match([{id:2,node:2,seats:1}],[{id:5,node:5,seats:4}],line()); assert.deepEqual(J(m.pairs),[{rider:2,driver:5,detour:0,seats:1}]);}
/* the closest car that passes is taken first */
{const m=R.match([{id:2,node:2,seats:1}],[{id:5,node:5,seats:4},{id:3,node:3,seats:4}],line()); assert.equal(m.pairs[0].driver,3);}
/* seat limits: a household of three does not fit in two free seats; two riders of two fill a car with four */
{const m=R.match([{id:2,node:2,seats:3}],[{id:5,node:5,seats:2}],line()); assert.equal(m.pairs.length,0);
 const m2=R.match([{id:1,node:1,seats:2},{id:2,node:2,seats:2},{id:3,node:3,seats:2}],[{id:5,node:5,seats:4}],line()); assert.equal(m2.pairs.length,2); assert.deepEqual(J(m2.left),[3]);
 const m3=R.match([{id:1,node:1,seats:1}],[{id:5,node:5,seats:0}],line()); assert.equal(m3.pairs.length,0);}
/* detour cap: the rider on the side road is 300 m off the driver's route, so 600 m there and back */
{const rider=[{id:6,node:6,seats:1}],driver=[{id:5,node:5,seats:4}];
 assert.deepEqual(J(R.match(rider,driver,line(),{cap:1000}).pairs),[{rider:6,driver:5,detour:600,seats:1}]);
 assert.equal(R.match(rider,driver,line(),{cap:599}).pairs.length,0);
 assert.equal(R.match(rider,driver,line(),{cap:600}).pairs.length,1);
 /* a driver nearer the exit has to come back for the rider: 2 x 200 m */
 assert.deepEqual(J(R.match([{id:3,node:3,seats:1}],[{id:2,node:2,seats:4}],line()).pairs),[{rider:3,driver:2,detour:400,seats:1}]);
 assert.equal(R.match([{id:5,node:5,seats:1}],[{id:1,node:1,seats:4}],line()).pairs.length,0);}
/* the whole run on the hand-built street */
{const net=line([[5,4]]),hhT=H([2,2,2,2,2,2,2]); hhT.uCar=Float32Array.from([1,1,1,0,1,1,0]);
 const Tn={...T,bg:[{...T.bg[0],nocar:[2,0],hh:[7,0]}]};   // share 2/7: households 3 and 6 have no car
 const out=R.run(Tn,hhT,{zone:Uint8Array.from([0,1,1,1,1,1,1]),clear:Uint8Array.from(net.next,v=>v!==-2?1:0),net});
 assert.deepEqual(Array.from(out.groups),[1,2,2,3,2,4,3]); assert.equal(out.leave[1],6); assert.equal(out.ride[1],2); assert.equal(out.cut[1],1);
 assert.equal(out.matched[1],2); assert.equal(out.city[1],1); assert.ok(out.leave[0]<=out.leave[1]&&out.leave[1]<=out.leave[2]);
 assert.ok(out.pairs.every(p=>p.detour<=R.DETOUR_M));}
/* mapped-slide distance rule: 100 m from a point, and from any part of a travel path */
{const at=(dx,dy)=>({...T,n:1,lon:Float64Array.of(-122+dx/87800),lat:Float64Array.of(37.9+dy/110950)}),pt=[[-122,37.9]],pathE=[[[-122,37.9],[-122+500/87800,37.9]]];
 assert.equal(R.nearSlides(at(99,0),pt,[])[0],1); assert.equal(R.nearSlides(at(101,0),pt,[])[0],0); assert.equal(R.nearSlides(at(70,70),pt,[])[0],1); assert.equal(R.nearSlides(at(72,72),pt,[])[0],0);
 assert.equal(R.nearSlides(at(250,99),[],pathE)[0],1); assert.equal(R.nearSlides(at(250,101),[],pathE)[0],0); assert.equal(R.nearSlides(at(599,0),[],pathE)[0],1); assert.equal(R.nearSlides(at(601,0),[],pathE)[0],0);
 assert.equal(R.nearSlides(at(140,0),pt,[],150)[0],1); assert.equal(R.NEAR_SLIDE_M,100);}
/* ranges are rounded and never a bare exact number unless low and high agree */
assert.equal(R.show([37.2,52,68.9]),'35 to 70'); assert.equal(R.show([0,0,0]),'0'); assert.equal(R.show([0,2,5.2]),'0 to 6');
console.log(`PASS: Census file, spreading, seeded households (${hh.n} simulated), four-way split, blocked routes, seat limits, detour cap, mapped-slide distance, ranges.`);
