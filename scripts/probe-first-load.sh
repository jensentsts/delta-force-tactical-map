#!/usr/bin/env bash
set -u
PORT=5199
./node_modules/.bin/vite --port $PORT --strictPort > vite-probe.log 2>&1 &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:$PORT/ && break; sleep 1; done
post() { curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$1"; }

cat > wb-nav.json <<'EOF'
{"action":"navigate","args":{"url":"http://localhost:5199/","newTab":true,"group_title":"首载复现"},"session":"tactical-map-firstload3"}
EOF
post wb-nav.json; echo; sleep 5

cat > wb-enter.json <<'EOF'
{"action":"evaluate","args":{"code":"(async()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('进入战术地图'));if(b){const r=b.getBoundingClientRect();const opts={bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2};for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])b.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,opts))}await new Promise(res=>setTimeout(res,2500));return 'in'})()"},"session":"tactical-map-firstload3"}
EOF
post wb-enter.json; echo

# 所有白线（capture + frontline）vs 所有非白线：最小屏幕距离 + 双方 pane
cat > wb-probe.json <<'EOF'
{"action":"evaluate","args":{"code":"(()=>{const all=[...document.querySelectorAll('.leaflet-pane svg path')].map(p=>{const m=p.getScreenCTM();if(!m)return null;const len=p.getTotalLength();if(!len)return null;const n=Math.min(300,Math.max(25,len|0));const pts=[];for(let i=0;i<=n;i++){const q=p.getPointAtLength(len*i/n).matrixTransform(m);pts.push({x:q.x,y:q.y})}let pane=p.closest('.leaflet-pane');while(pane&&pane.classList.contains('leaflet-vector-frame'))pane=pane.parentElement.closest('.leaflet-pane');const cs=getComputedStyle(p);return{cls:(p.getAttribute('class')||'').split(' ')[0],stroke:(p.getAttribute('stroke')||cs.stroke||'').toLowerCase(),dash:cs.strokeDasharray,pane:pane?pane.className.replace('leaflet-pane','').trim():'?',paneZ:pane?(pane.style.zIndex||'?'):'?',pts}}).filter(Boolean);const whites=all.filter(x=>x.stroke==='#ffffff');const others=all.filter(x=>x.stroke&&x.stroke!=='#ffffff'&&x.stroke!=='none');const out=[];for(const w of whites){for(const o of others){let best=1e9,bt=null;for(const a of w.pts){for(const b of o.pts){const d=Math.hypot(a.x-b.x,a.y-b.y);if(d<best){best=d;bt={x:a.x|0,y:a.y|0}}}}if(best<8)out.push({wCls:w.cls,wPane:w.pane,wZ:w.paneZ,oCls:o.cls,oStroke:o.stroke,oDash:o.dash,oPane:o.pane,oZ:o.paneZ,d:+best.toFixed(1),at:bt})}}return JSON.stringify(out)})()"},"session":"tactical-map-firstload3"}
EOF
post wb-probe.json; echo

cat > wb-shot.json <<'EOF'
{"action":"screenshot","args":{"format":"jpeg","quality":80},"session":"tactical-map-firstload3"}
EOF
post wb-shot.json; echo
