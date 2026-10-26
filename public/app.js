(function(){
"use strict";
var AREAS,SHOPS,P,WT,VEHICLES,BOX,ID_TYPES=[],PUSH=false,VAPID="",seenJobs=null,GOOGLE_CLIENT_ID="",MPESA=false,FEES={},DEFER_MIN=999,payMethod="mpesa",payPoll=null;
var STEPS=["Pending","In Progress","Completed"],OTHER="__other__";
var speed="standard",mode="login",role="sender",me=null,busy=false,pins={pick:null,drop:null},myShops=[],cache={mine:[],jobs:[],jm:[]},pendingG=null,resendAt=0,adminTab="pending",docVer={},catalog=[],cart={},cartShop=null,lastQ=null,shopOpen={},adminShops=[];
function $(i){return document.getElementById(i)}
function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
function toast(m){var t=$("toast");t.textContent=m;t.classList.add("on");clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.remove("on")},2800)}
function fmt(n){return "KES "+n.toLocaleString("en-KE")}
function feeKey(a,b){return[a,b].sort().join("|")}
function quote(f,t,w,s){var d=Math.abs(AREAS[f].pos-AREAS[t].pos),route=f===t?P.local:P.base+Math.round(d*P.perKm),
  ferry=(f!==t&&(AREAS[f].pos<=0)!==(AREAS[t].pos<=0))?P.ferry:0,custom=FEES[feeKey(f,t)];if(typeof custom==="number"){route=custom;ferry=0}var wf=WT[w].f,sub=route+wf+ferry,ex=s==="express"?Math.round(sub*P.expressPct):0;
  return{d:d,route:route,wf:wf,ferry:ferry,ex:ex,total:Math.round((sub+ex)/10)*10}}
function norm(p){return p.replace(/[\s\-()]/g,"")}
function phoneOk(p){return /^(\+?254|0)[17]\d{8}$/.test(norm(p))}
function emailOk(e){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)}
/* Server API: session lives in an HttpOnly cookie the page cannot read */
function api(method,path,body){
  var opt={method:method,credentials:"same-origin",headers:{}};
  if(method!=="GET"){opt.headers["Content-Type"]="application/json";opt.body=JSON.stringify(body||{})}
  return fetch("/api"+path,opt).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    if(!r.ok){var e=new Error(j.error||"Request failed.");e.status=r.status;e.data=j;if(r.status===401&&me&&path.indexOf("/auth/")!==0)sessionEnded();throw e}return j})},
    function(){throw new Error("Cannot reach the server. Check your connection.")})}
function sessionEnded(){if(!me)return;resetLocal();toast("Your session expired. Please log in again.")}
function resetLocal(){me=null;seenJobs=null;myShops=[];cart={};cartShop=null;cache={mine:[],jobs:[],jm:[]};try{google.accounts.id.disableAutoSelect()}catch(e){}
  ["a-name","a-phone","a-email","a-pw","a-code","a-idn","a-dob","a-addr","a-shop","shopOther","land","drop","it","rn","rp","q","mpPhone"].forEach(function(i){$(i).value=""});closePay();payMethod="cod";
  pins.pick=null;pins.drop=null;setRole("sender");setMode("login");show("auth")}

/* Map */
function order(){return Object.keys(AREAS).sort(function(a,b){return AREAS[a].pos-AREAS[b].pos})}
/* stops from a to b, in route order, including every stop in between */
function stops(f,t){var o=order(),i=o.indexOf(f),j=o.indexOf(t);return i<=j?o.slice(i,j+1):o.slice(j,i+1).reverse()}
/* smooth path through the points: straight runs with rounded corners at each stop */
function pathThrough(pts){var d="M"+pts[0].x+" "+pts[0].y;if(pts.length<2)return d;
  for(var i=1;i<pts.length-1;i++){var c=pts[i],n=pts[i+1],mx=(c.x+n.x)/2,my=(c.y+n.y)/2,pv=pts[i-1];
    if(i===1)d+=" L"+((pv.x+c.x)/2)+" "+((pv.y+c.y)/2);d+=" Q"+c.x+" "+c.y+" "+mx+" "+my}
  var e=pts[pts.length-1];return d+" L"+e.x+" "+e.y}
function dots(via){var s="";via=via||[];for(var n in AREAS){var c=AREAS[n],l=c.side==="l",on=via.indexOf(n)>-1;
  s+='<circle cx="'+c.x+'" cy="'+c.y+'" r="5" fill="'+(on?"var(--pri)":"var(--mut)")+'"/><text x="'+(l?c.x-9:c.x+9)+'" y="'+(c.y+4)+'" text-anchor="'+(l?"end":"start")+'">'+n+'</text>'}return s}
function drawMap(svg,f,t){
  var s='<rect width="320" height="210" rx="14" fill="var(--land)"/><path d="M320 0L250 0L244 30L232 56L218 80L206 106L200 132L182 160L208 210L320 210Z" fill="var(--sea)"/><text class="sea" x="268" y="110" text-anchor="middle">Indian Ocean</text>',p,o=order();
  if(f&&t&&f!==t){var st=stops(f,t),pts=st.map(function(n){return AREAS[n]}),a=AREAS[f],b=AREAS[t];p=pathThrough(pts);
    s+='<path class="route" d="'+p+'"/>'+dots(st)+'<circle class="pulse" cx="'+a.x+'" cy="'+a.y+'" r="6" fill="var(--pri)"/><circle cx="'+b.x+'" cy="'+b.y+'" r="7" fill="var(--ok)"/>'}
  else if(f&&t){var c=AREAS[f];p="M"+(c.x-14)+" "+(c.y+14)+" q14 -22 28 0 q-14 22 -28 0";s+=dots()+'<circle class="pulse" cx="'+c.x+'" cy="'+c.y+'" r="7" fill="var(--pri)"/>'}
  else{p=pathThrough(o.map(function(n){return AREAS[n]}));s+='<path class="route" d="'+p+'" opacity=".6"/>'+dots()}
  s+='<g><text x="-8" y="6" style="font-size:16px">🚚</text><animateMotion dur="'+(f&&t?"3.5s":"7s")+'" repeatCount="indefinite" path="'+p+'"/></g>';
  svg.innerHTML=s}

/* Pin location (share GPS or paste a Google Maps link; opens in Google Maps) */
function mapsUrl(p){return "https://www.google.com/maps/search/?api=1&query="+p.lat+","+p.lng}
function dirUrl(p){return "https://www.google.com/maps/dir/?api=1&destination="+p.lat+","+p.lng}
function inArea(a,b){return a>BOX.latMin&&a<BOX.latMax&&b>BOX.lngMin&&b<BOX.lngMax}
function pinChip(p,label,nav){var d=el("div","pin"),t=el("div","t"),a=el("a",null,nav?"Navigate":"Open");
  d.appendChild(el("div","ic","📍"));t.appendChild(el("b",null,label));t.appendChild(el("small",null,p.lat.toFixed(5)+", "+p.lng.toFixed(5)));d.appendChild(t);
  a.href=nav?dirUrl(p):mapsUrl(p);a.target="_blank";a.rel="noopener noreferrer";a.addEventListener("click",function(e){e.stopPropagation()});d.appendChild(a);return d}
function pinBlock(key,box,title){
  function draw(){box.textContent="";var cur=pins[key];
    if(cur){box.appendChild(pinChip(cur,title+" pinned",false));var rm=el("button","lnk","Remove pin");rm.type="button";rm.onclick=function(){pins[key]=null;draw()};box.appendChild(rm);return}
    var lab="📍 Share my current location",b=el("button","btn sec",lab),msg=el("div","note"),inp=el("input");b.type="button";
    inp.placeholder="…or paste a Google Maps link or coordinates";inp.style.marginTop="8px";inp.setAttribute("aria-label",title+" Google Maps link");
    function setPin(lat,lng){if(!isFinite(lat)||!isFinite(lng)||!inArea(lat,lng)){msg.textContent="That location is outside our service area (Mombasa to Diani).";return}
      pins[key]={lat:Math.round(lat*1e6)/1e6,lng:Math.round(lng*1e6)/1e6};draw()}
    b.onclick=function(){if(!navigator.geolocation){msg.textContent="Location is not available here. Paste a Google Maps link instead.";return}
      b.disabled=true;b.textContent="Finding you…";msg.textContent="";
      navigator.geolocation.getCurrentPosition(function(r){b.disabled=false;b.textContent=lab;setPin(r.coords.latitude,r.coords.longitude)},
        function(e){b.disabled=false;b.textContent=lab;msg.textContent=e.code===1?"Location access is blocked. Allow it in your browser settings, or paste a Google Maps link.":"Could not get your location. Try again outdoors or paste a Google Maps link."},
        {enableHighAccuracy:true,timeout:15000,maximumAge:0})};
    inp.addEventListener("change",function(){var v=inp.value,m=v.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)||v.match(/(-?\d{1,2}\.\d{3,})\s*[,;]\s*(-?\d{1,3}\.\d{3,})/);
      if(!m){msg.textContent="No coordinates found. Short links (maps.app.goo.gl) cannot be read: open it and copy the full link, or share your location.";return}
      setPin(parseFloat(m[1]),parseFloat(m[2]))});
    box.appendChild(b);box.appendChild(inp);box.appendChild(msg)}
  draw()}
function initPins(){pins.pick=null;pins.drop=null;pinBlock("pick",$("pin-pick"),"Pickup");pinBlock("drop",$("pin-drop"),"Drop-off")}

/* Navigation & roles */
var VIEWS=["auth","home","new","hist","jobs","mine","verify","admin","shops","fees","money","subs","owner","set"],SENDER=["home","new","hist"],SHIPPER=["jobs","mine"];
function show(v){VIEWS.forEach(function(k){$("v-"+k).classList.toggle("on",k===v)});$("nav").classList.toggle("on",v!=="auth");
  document.querySelectorAll("#nav button").forEach(function(b){b.classList.toggle("on",b.dataset.go===v)});window.scrollTo(0,0)}
function go(v){if(!me){show("auth");return}
  if(me.role==="owner"){if(v!=="owner"&&v!=="set")v="owner"}
  else if(me.role==="subadmin"){if(v!=="admin"&&v!=="set")v="admin"}
  else if(me.role==="admin"){if(v!=="admin"&&v!=="shops"&&v!=="fees"&&v!=="money"&&v!=="subs"&&v!=="set")v="admin"}
  else if(me.role==="shipper"){if(me.status!=="approved"){if(v!=="set")v="verify"}else if(SENDER.indexOf(v)>-1||v==="verify"||v==="admin"||v==="shops"||v==="fees"||v==="money"||v==="subs"||v==="owner")v="jobs"}
  else if(SHIPPER.indexOf(v)>-1||v==="verify"||v==="admin"||v==="shops"||v==="fees"||v==="money"||v==="subs"||v==="owner")v="home";
  show(v);if(v==="home")renderHome();if(v==="hist")renderList(true);if(v==="new"){loadCatalog();updatePrice()}if(v==="set")fillProfile();if(v==="jobs")renderJobs();if(v==="mine")renderMine();if(v==="verify")renderVerify();if(v==="admin")renderAdmin();if(v==="shops")renderShops();if(v==="fees")renderFees();if(v==="owner")renderOwner();if(v==="money")renderMoney();if(v==="subs")renderSubs();if(v==="set")pushRefresh()}
/* bottom bar: admins see Review; shippers see Verify until an admin approves them, then Jobs */
function navFor(u){document.querySelectorAll("#nav button[data-r]").forEach(function(b){var h=(" "+b.dataset.r+" ").indexOf(" "+u.role+" ")<0;
  if(!h&&u.role==="shipper"){var ap=u.status==="approved";h=b.dataset.go==="verify"?ap:!ap}b.classList.toggle("hide",h)})}
function refreshMe(){return api("GET","/me").then(function(j){var old=me&&me.status,cur=document.querySelector(".view.on"),id=cur?cur.id:"";me=j.user;navFor(me);
  if(me.role==="shipper"&&old!==me.status&&["v-verify","v-jobs","v-mine"].indexOf(id)>-1){
    if(me.status==="approved"){toast("You are approved! You can now accept jobs.");$("jf").value=me.area||"all"}go("verify")}},function(){})}
document.addEventListener("click",function(e){var g=e.target.closest("[data-go]");if(g)go(g.dataset.go)});

/* Auth */
function setRole(r){role=r;document.querySelectorAll("#roleSeg button").forEach(function(b){b.classList.toggle("on",b.dataset.r===r)});
  var su=mode==="signup"||mode==="gsetup";$("g-ship").style.display=(su&&r==="shipper")?"block":"none";$("g-owner").style.display=(su&&r==="owner")?"block":"none";
  $("roleNote").textContent=r==="sender"?"Request deliveries from local shops.":r==="owner"?"Sell through SMD: list your goods and their prices.":"Accept delivery jobs and get paid on delivery."}
function setMode(m){mode=m;$("aErr").textContent="";
  var T={login:["Welcome back","Log in to continue.","Log in","New here? Sign up"],signup:["Create account","Choose your account type to begin.","Sign up","Have an account? Log in"],
    forgot:["Reset password","Enter your email and we will send you a reset code.","Send reset code","Back to log in"],
    reset:["Enter reset code","Enter the code we sent and choose a new password.","Reset password","Back to log in"],
    gsetup:["Almost there","Finish setting up your account.","Create my account","Cancel"],
    verify:["Verify your email","Enter the 6-digit code we sent to your email.","Verify email","Back to log in"]}[m];
  $("aT").textContent=T[0];$("aS").textContent=T[1];$("aBtn").textContent=T[2];$("aSw").textContent=T[3];
  var gs=m==="gsetup",sg=m==="signup"||gs;$("g-role").style.display=sg?"block":"none";$("g-name").style.display=sg?"block":"none";$("g-phone").style.display=sg?"block":"none";
  $("g-cred").style.display=gs?"none":"block";var vf=m==="verify";$("g-code").style.display=(m==="reset"||vf)?"block":"none";$("l-code").textContent=vf?"Verification code":"Reset code";$("a-code").maxLength=vf?6:12;$("a-code").inputMode=vf?"numeric":"text";$("a-email").readOnly=vf;
  var nopw=m==="forgot"||vf;$("a-pw").parentNode.style.display=nopw?"none":"block";var pwi=$("a-pw");pwi.type="password";$("l-pw").style.display=nopw?"none":"block";
  $("g-google").style.display=(m==="login"||m==="signup")?"block":"none";
  $("l-pw").textContent=m==="reset"?"New password":"Password";$("a-pw").autocomplete=m==="login"?"current-password":"new-password";
  $("aFg").style.display=(m==="login"||vf)?"inline":"none";$("aFg").textContent=vf?"Resend code":"Forgot password?";setRole(role);renderG()}
$("roleSeg").addEventListener("click",function(e){var b=e.target.closest("button");if(b)setRole(b.dataset.r)});
$("aSw").addEventListener("click",function(){pendingG=null;setMode(mode==="login"?"signup":"login")});
$("aFg").addEventListener("click",function(){if(mode==="verify")return resendCode();setMode("forgot")});
$("a-code").addEventListener("keydown",function(e){if(e.key==="Enter")$("aBtn").click()});
function toVerify(email,msg){busy=false;$("aBtn").disabled=false;$("a-pw").value="";$("a-code").value="";setMode("verify");$("a-email").value=email;$("aS").textContent=msg;resendAt=Date.now()+60000;$("a-code").focus()}
function resendCode(){var em=$("a-email").value.trim().toLowerCase();if(Date.now()<resendAt){toast("Please wait a minute before asking for another code.");return}
  resendAt=Date.now()+60000;api("POST","/auth/resend",{email:em}).then(function(){toast("If this email is waiting for verification, a new code was sent.")},function(e){toast(e.message)})}
$("a-pw").addEventListener("keydown",function(e){if(e.key==="Enter")$("aBtn").click()});
function aerr(m){$("aErr").textContent=m;busy=false;$("aBtn").disabled=false}
function work(){busy=true;$("aBtn").disabled=true}
function shipFields(b){if(role==="owner"){b.shopName=$("a-shop").value.trim();b.area=$("a-oarea").value}if(role==="shipper"){b.veh=$("a-veh").value;b.area=$("a-area").value;b.idType=$("a-idt").value;b.idNumber=$("a-idn").value.trim();b.dob=$("a-dob").value;b.address=$("a-addr").value.trim()}return b}
function shipCheck(){if(role==="owner")return $("a-shop").value.trim().length<2?"Enter your shop name.":"";if(role!=="shipper")return"";if(!/^[A-Za-z0-9\/\s-]{5,20}$/.test($("a-idn").value.trim()))return"Enter your ID number.";if(!$("a-dob").value)return"Enter your date of birth.";if($("a-addr").value.trim().length<5)return"Enter your home address.";return""}
$("aBtn").addEventListener("click",function(){
  if(busy)return;var name=$("a-name").value.trim(),ph=$("a-phone").value.trim(),em=$("a-email").value.trim().toLowerCase(),pw=$("a-pw").value,code=$("a-code").value.trim();
  $("aErr").textContent="";
  if(mode==="gsetup")return gFinish(name,ph);
  if(!emailOk(em))return aerr("Enter a valid email address.");
  var fl=function(e){aerr(e.message)};
  if(mode==="verify"){if(!/^\d{6}$/.test(code))return aerr("Enter the 6-digit code from your email.");work();
    return api("POST","/auth/verify",{email:em,code:code}).then(function(j){start(j.user)}).catch(fl)}
  if(mode==="forgot"){work();return api("POST","/auth/forgot",{email:em}).then(function(){busy=false;$("aBtn").disabled=false;toast("If that account exists, a reset code was sent.");setMode("reset")}).catch(fl)}
  if(mode==="reset"){if(code.length<6)return aerr("Enter the reset code.");if(pw.length<8)return aerr("Password must be at least 8 characters.");work();
    return api("POST","/auth/reset",{email:em,code:code,password:pw}).then(function(){busy=false;$("aBtn").disabled=false;$("a-pw").value="";$("a-code").value="";toast("Password updated. Log in.");setMode("login")}).catch(fl)}
  if(mode==="login"&&!pw)return aerr("Enter your password.");
  if(mode==="signup"){if(pw.length<8)return aerr("Password must be at least 8 characters.");if(name.length<2)return aerr("Enter your full name.");if(!phoneOk(ph))return aerr("Enter a valid phone, e.g. 0712 345 678.");var se=shipCheck();if(se)return aerr(se)}
  work();
  var req=mode==="signup"?api("POST","/auth/signup",shipFields({name:name,phone:ph,email:em,password:pw,role:role})):api("POST","/auth/login",{email:em,password:pw});
  req.then(function(j){if(j.needsVerify)return toVerify(j.email,"We sent a 6-digit code to "+j.email+". Enter it to continue.");start(j.user)})
    .catch(function(e){if(e.data&&e.data.needsVerify)return toVerify(e.data.email||em,e.message);fl(e)})});
function start(u,shops){
  me=u;myShops=shops||[];busy=false;$("aBtn").disabled=false;["a-name","a-phone","a-email","a-pw","a-code","a-idn","a-dob","a-addr","a-shop"].forEach(function(i){$(i).value=""});navFor(u);
  var f=u.name.split(" ")[0];$("hi").textContent="Hi, "+f+"!";$("hj").textContent="Hi, "+f+"!";
  if(u.role==="sender"){initPins();if(!shops)api("GET","/me").then(function(j){myShops=j.shops;fillShops()},function(){});fillShops();loadCatalog()}else if(u.role==="shipper"){$("jf").value=u.area||"all";pushSync();watchStart()}
  go(u.role==="admin"||u.role==="subadmin"?"admin":u.role==="owner"?"owner":u.role==="shipper"?"jobs":"home")}
$("delOpen").addEventListener("click",function(){var b=$("delBox");b.style.display=b.style.display==="none"?"block":"none"});
$("delGo").addEventListener("click",function(){var btn=$("delGo");$("delErr").textContent="";if($("delTxt").value.trim()!=="DELETE"){$("delErr").textContent="Type DELETE to confirm.";return}
  btn.disabled=true;api("POST","/me/delete",{confirm:"DELETE",password:$("delPw").value}).then(function(){$("delPw").value="";$("delTxt").value="";$("delBox").style.display="none";resetLocal();toast("Your account has been deleted")},function(e){btn.disabled=false;$("delErr").textContent=e.message})});
$("out").addEventListener("click",function(){pushDrop().then(function(){return api("POST","/auth/logout")}).catch(function(){}).then(function(){resetLocal();toast("Logged out")})});

/* Google sign-in (token is verified by the server) */
var gReady=false;
function renderG(){if(!gReady)return;var b=$("gBtn");b.textContent="";google.accounts.id.renderButton(b,{theme:"outline",size:"large",shape:"pill",text:mode==="signup"?"signup_with":"continue_with",width:Math.max(200,Math.min(360,b.clientWidth||300))})}
function loadG(){if(!GOOGLE_CLIENT_ID){$("gNote").textContent="Google sign-in is not enabled on this server.";return}
  var sc=document.createElement("script");sc.src="https://accounts.google.com/gsi/client";sc.async=true;
  sc.onload=function(){try{google.accounts.id.initialize({client_id:GOOGLE_CLIENT_ID,callback:onG,auto_select:false,cancel_on_tap_outside:true});gReady=true;renderG()}catch(e){$("gNote").textContent="Google sign-in could not start."}};
  sc.onerror=function(){$("gNote").textContent="Could not reach Google. Check your connection."};document.head.appendChild(sc)}
function onG(r){api("POST","/auth/google",{credential:r&&r.credential}).then(function(j){
  if(j.needsSetup){pendingG={setup:j.setup,email:j.email};setMode("gsetup");$("a-name").value=j.name||"";$("aS").textContent="Signed in as "+j.email+". Finish setting up your account."}else start(j.user)}).catch(function(e){aerr(e.message)})}
function gFinish(name,ph){if(!pendingG)return aerr("Please start again with Google.");
  if(name.length<2)return aerr("Enter your full name.");if(!phoneOk(ph))return aerr("Enter a valid phone, e.g. 0712 345 678.");var se=shipCheck();if(se)return aerr(se);
  work();api("POST","/auth/google/complete",shipFields({setup:pendingG.setup,name:name,phone:ph,role:role})).then(function(j){pendingG=null;start(j.user)}).catch(function(e){aerr(e.message)})}

/* Ratings: 1-5 stars, shown as filled/empty stars */
function starStr(n){var r=Math.round(n),o="";for(var i=1;i<=5;i++)o+=i<=r?"★":"☆";return o}
function starsRow(t,n){var p=el("div"),a=el("span","stars",starStr(n));p.style.cssText="font-size:13px;margin:6px 0";p.appendChild(document.createTextNode(t));p.appendChild(a);return p}
function rateBox(x){var w=el("div"),h=el("b",null,"How was the delivery? Rate your shipper"),r=el("div","rate");h.style.cssText="font-size:13px;display:block;margin-top:8px";w.appendChild(h);
  for(var i=1;i<=5;i++)(function(n){var b=el("button",null,"★");b.type="button";b.setAttribute("aria-label",n+" star"+(n>1?"s":""));
    b.onmouseenter=function(){[].forEach.call(r.children,function(c,k){c.classList.toggle("on",k<n)})};
    b.onclick=function(e){e.stopPropagation();[].forEach.call(r.children,function(c){c.disabled=true});
      api("POST","/deliveries/"+encodeURIComponent(x.id)+"/rate",{stars:n}).then(function(){toast("Thanks for rating!")},function(er){toast(er.message)}).then(function(){renderList(false,x.id)})};r.appendChild(b)})(i);
  r.onmouseleave=function(){[].forEach.call(r.children,function(c){c.classList.remove("on")})};w.appendChild(r);return w}

/* Near you (sender home): recommended shops and available shippers with their ratings */
function nearRow(l1,l2,btn){var d=el("div","nb"),t=el("div");t.appendChild(el("b",null,l1));t.appendChild(el("small",null,l2));d.appendChild(t);if(btn)d.appendChild(btn);return d}
function loadNear(){var a=$("nbArea").value;try{localStorage.setItem("smd_area",a)}catch(e){}
  return api("GET","/nearby?area="+encodeURIComponent(a)).then(function(j){if(j.area!==$("nbArea").value)return;var sb=$("nbShops"),pb=$("nbShips");sb.textContent="";pb.textContent="";
    if(!j.shops.length)sb.appendChild(el("p","note","No recommended shops in "+a+" yet. You can still type any shop when you request a delivery."));
    j.shops.forEach(function(s){var b=el("button","lnk","Order");b.type="button";b.onclick=function(){orderFrom(a,s.id)};sb.appendChild(nearRow(s.name,s.goods?s.goods+" goods listed":"Tell us what you need",b))});
    if(!j.shippers.length)pb.appendChild(el("p","note","No shippers are free in "+a+" right now. Requests still reach shippers from nearby areas."));
    j.shippers.forEach(function(p){var r=p.avg==null?"New · no ratings yet":null,d=nearRow(p.name,p.veh+" · "+p.done+" delivered"),st=el("div");st.style.textAlign="right";
      if(r)st.appendChild(el("small",null,"New"));else{st.appendChild(el("span","stars",starStr(p.avg)));st.appendChild(el("small",null,p.avg.toFixed(1)+" ("+p.count+")"))}d.appendChild(st);pb.appendChild(d)})},function(){})}
function orderFrom(a,id){$("from").value=a;fillShops();var s=$("shopSel");s.value="c:"+id;shopToggle();updatePrice();go("new")}
$("nbArea").addEventListener("change",loadNear);

/* Shop owner dashboard: add, hide and remove goods */
var ownerShop=null;
function ownerDraw(j){ownerShop=j.shop;var mo=j.money;$("oMoney").textContent=mo&&mo.orders?"Sales paid through the app: "+fmt(mo.earned)+" from "+mo.orders+" orders · paid to you "+fmt(mo.paid)+" · waiting for payout "+fmt(mo.owed):"";var sh=j.shop,st=$("oState");st.textContent="";
  $("o-name").value=sh.name;
  var tg=el("span","tag"+(sh.approved?"":" warn"),sh.approved?"✓ Live: customers can order from you":"Waiting for admin approval");
  var l=el("p","note",sh.approved?"Shop area: "+sh.area+(sh.rec?" · ⭐ Recommended by SMD":""):"Shop area: "+sh.area+". Customers cannot see your shop until an admin approves it. You can add your goods now.");
  st.appendChild(tg);st.appendChild(l);
  var box=$("oList");box.textContent="";var ad=$("oAdd");ad.textContent="";ad.appendChild(ownerEditor(null));
  if(!sh.items.length){box.appendChild(el("div","card empty","No goods yet. Add your first one above."));return}
  var c=el("div","card");c.appendChild(el("b",null,"Your goods ("+sh.items.length+")"));sh.items.forEach(function(it){c.appendChild(ownerEditor(it))});box.appendChild(c)}
function oCall(method,path,body,done){return api(method,path,body).then(function(j){ownerDraw(j);if(done)done()},function(e){toast(e.message)})}
function ownerEditor(it){var d=el("div","ied"),r=el("div","row"),nm=el("input"),un=el("input"),pr=el("input"),r2=el("div","row"),bt=el("div","btns");
  nm.value=it?it.name:"";nm.maxLength=60;nm.placeholder="Item (e.g. Sugar)";nm.setAttribute("aria-label","Item name");
  un.value=it?it.unit:"";un.maxLength=20;un.placeholder="Unit (e.g. 1 kg)";un.setAttribute("aria-label","Unit");
  pr.type="number";pr.inputMode="numeric";pr.min="1";pr.value=it?it.price:"";pr.placeholder="Price KES";pr.setAttribute("aria-label","Price in shillings");
  r.style.gridTemplateColumns="1fr";r.appendChild(nm);d.appendChild(r);r2.appendChild(un);r2.appendChild(pr);d.appendChild(r2);
  function body(){var p=numIn(pr.value);if(nm.value.trim().length<2||!un.value.trim()||!(p>0)){toast("Fill in the item, unit and a price.");return null}return{name:nm.value.trim(),unit:un.value.trim(),price:p}}
  if(it){var sv=el("button","btn sec","Save"),hd=el("button","btn sec",it.active?"Hide":"Show"),rm=el("button","btn sec dng","Remove"),armed=false;
    sv.onclick=function(){var b=body();if(b)oCall("PATCH","/owner/items/"+it.id,b,function(){toast("Saved")})};
    hd.onclick=function(){oCall("PATCH","/owner/items/"+it.id,{active:!it.active})};
    rm.onclick=function(){if(!armed){armed=true;rm.textContent="Tap again";setTimeout(function(){armed=false;rm.textContent="Remove"},3000);return}oCall("DELETE","/owner/items/"+it.id,null,function(){toast("Removed")})};
    bt.style.gridTemplateColumns="repeat(3,1fr)";bt.appendChild(sv);bt.appendChild(hd);bt.appendChild(rm);if(!it.active)nm.style.opacity=".55"}
  else{var a=el("button","btn","Add good");a.style.marginTop="6px";a.onclick=function(){var b=body();if(b)oCall("POST","/owner/items",b,function(){toast("Added")})};bt.style.gridTemplateColumns="1fr";bt.appendChild(a)}
  d.appendChild(bt);return d}
function renderOwner(){return api("GET","/owner/shop").then(ownerDraw,function(e){toast(e.message)})}
$("o-save").addEventListener("click",function(){var n=$("o-name").value.trim();$("oErr").textContent="";if(n.length<2){$("oErr").textContent="Enter the shop name.";return}
  api("PATCH","/owner/shop",{name:n}).then(function(j){ownerDraw(j);toast("Shop name saved")},function(e){$("oErr").textContent=e.message})});

/* Job alerts for shippers: phone notifications (Web Push) plus an in-app alert while the app is open */
function b64u(t){var p="=".repeat((4-t.length%4)%4),b=(t+p).replace(/-/g,"+").replace(/_/g,"/"),r=atob(b),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function pushOk(){return PUSH&&"serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window}
function pushReg(){return navigator.serviceWorker.ready}
function pushSub(){return pushOk()?pushReg().then(function(r){return r.pushManager.getSubscription()}):Promise.resolve(null)}
function pushRefresh(){var c=$("pushCard");if(!me||me.role!=="shipper"||me.status!=="approved"||!PUSH){c.style.display="none";return}c.style.display="block";
  if(!pushOk()){$("pushNote").textContent="This browser cannot show job alerts. Install SMD from Chrome (Settings > Install the SMD app) or use the latest Chrome on Android.";$("pushBtn").style.display="none";return}
  $("pushBtn").style.display="block";
  if(window.Notification&&Notification.permission==="denied"){$("pushNote").textContent="Notifications are blocked for SMD. Allow them in your browser or phone settings, then come back.";$("pushBtn").style.display="none";return}
  pushSub().then(function(sub){$("pushBtn").textContent=sub?"Turn off job alerts":"Turn on job alerts";$("pushBtn").dataset.on=sub?"1":"";
    $("pushNote").textContent=sub?"On: you will get an alert when a new delivery appears near your base area. You stay signed in on this phone to receive them.":"Get a phone alert when a new delivery appears near you, even when the app is closed. You must stay logged in."})}
function pushSend(sub){return api("POST","/push/subscribe",sub.toJSON())}
$("pushBtn").addEventListener("click",function(){var b=$("pushBtn");b.disabled=true;
  var p=b.dataset.on?pushDrop().then(function(){toast("Job alerts are off")}):Notification.requestPermission().then(function(r){if(r!=="granted")throw new Error("Allow notifications to get job alerts.");
    return pushReg().then(function(reg){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u(VAPID)})})}).then(pushSend).then(function(){toast("Job alerts are on")});
  p.catch(function(e){toast(e.message||"Could not change job alerts.")}).then(function(){b.disabled=false;pushRefresh()})});
function pushDrop(){return pushSub().then(function(sub){if(!sub)return;var ep=sub.endpoint;return api("POST","/push/unsubscribe",{endpoint:ep}).catch(function(){}).then(function(){return sub.unsubscribe()})}).catch(function(){})}
function pushSync(){if(!pushOk()||!me||me.status!=="approved"||Notification.permission!=="granted")return;pushSub().then(function(sub){if(sub)pushSend(sub).catch(function(){})}).catch(function(){})}
/* While the app is open, check for new jobs near the shipper's base every 20 s and tell them right away */
var watching=false;
function watchStart(){if(watching)return;watching=true;setInterval(function(){
  if(!me||me.role!=="shipper"||me.status!=="approved"||document.hidden)return;
  api("GET","/jobs?area=all").then(function(list){var ids={};list.forEach(function(j){ids[j.id]=1});
    if(seenJobs){var fresh=list.filter(function(j){return !seenJobs[j.id]&&AREAS[me.area]&&Math.abs(AREAS[j.from].pos-AREAS[me.area].pos)<=10});
      if(fresh.length){var j=fresh[0];toast("🔔 New job: "+j.from+" → "+j.to+" · "+fmt(j.price));try{navigator.vibrate&&navigator.vibrate([200,100,200])}catch(e){}
        var v=document.querySelector(".view.on");if(v&&v.id==="v-jobs")renderJobs()}}
    seenJobs=ids},function(){})},20000)}

/* Admin: Money (what is owed, payouts, refunds) */
function moneyRow(l1,l2,right,btn){var d=el("div","nb"),t=el("div");t.appendChild(el("b",null,l1));t.appendChild(el("small",null,l2));d.appendChild(t);
  var r=el("div");r.style.cssText="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px";if(right)r.appendChild(el("b",null,right));if(btn)r.appendChild(btn);d.appendChild(r);return d}
function payoutBtn(kind,x,reload){var b=el("button","btn sec","Mark paid");b.style.cssText="margin:0;padding:6px 12px;width:auto";b.type="button";
  b.onclick=function(){var v=window.prompt("How much did you send to "+x.name+"? (owed: KES "+x.owed+")",String(x.owed));if(v===null)return;var n=Math.round(Number(v));if(!(n>0)){toast("Enter an amount.");return}
    var note=window.prompt("M-Pesa code or note (optional)","")||"";b.disabled=true;
    api("POST","/admin/payouts",{kind:kind,ref:x.ref,amount:n,note:note.trim()}).then(function(){toast("Payout recorded");reload()},function(e){b.disabled=false;toast(e.message)})};return b}
function renderMoney(){return api("GET","/admin/money").then(function(j){
  var sm=$("mSum");sm.textContent="";sm.style.gridTemplateColumns="repeat(2,1fr)";[["Collected",fmt(j.collected)],["Your "+j.platformPct+"% share",fmt(j.platformEarned)],["Owed shippers",fmt(j.owedShippers)],["Owed shops",fmt(j.owedShops)]].forEach(function(r){var c=el("div","card stat");c.appendChild(el("b",null,r[1]));c.appendChild(el("span",null,r[0]));c.querySelector("b").style.fontSize="16px";sm.appendChild(c)});
  $("mNote").textContent="You keep "+j.platformPct+"% of each delivery fee; the shipper gets "+j.share+"%; shops get the goods amount. Only orders paid through M-Pesa and completed are counted.";
  var box=$("mIssues");box.textContent="";var open=j.issues.filter(function(i){return !i.refunded});
  if(!j.issues.length)box.appendChild(el("p","note","No problem payments."));
  j.issues.forEach(function(i){var lab={duplicate:"Paid twice",mismatch:"Wrong amount",orphan:"Order was deleted"}[i.status]||i.status,btn=null;
    if(!i.refunded){btn=el("button","btn sec","Mark refunded");btn.style.cssText="margin:0;padding:6px 12px;width:auto";btn.type="button";
      btn.onclick=function(){var n=window.prompt("Refund done. Add a note (optional), e.g. the reversal code","");if(n===null)return;btn.disabled=true;api("POST","/admin/payments/"+i.id+"/refunded",{note:n.trim()}).then(function(){toast("Marked as refunded");renderMoney()},function(e){btn.disabled=false;toast(e.message)})}}
    box.appendChild(moneyRow(lab+" · "+fmt(i.amount),(i.name?i.name+" · ":"")+i.phone+" · "+(i.receipt||"no receipt")+" · "+i.order+(i.desc&&i.status==="mismatch"?" ("+i.desc+")":""),i.refunded?"✓ Refunded":"",btn))});
  function list(box,arr,kind,empty){box.textContent="";var any=false;arr.forEach(function(x){any=true;
    var sub=(kind==="shipper"?x.phone+" · ":(x.owner?x.owner+" · "+x.phone+" · ":""))+x.n+" orders · earned "+fmt(x.earned)+" · paid "+fmt(x.paid);
    box.appendChild(moneyRow(x.name+(x.area?" ("+x.area+")":""),sub,x.owed?fmt(x.owed):"✓ settled",x.owed?payoutBtn(kind,x,renderMoney):null))});
    if(!any)box.appendChild(el("p","note",empty))}
  list($("mShips"),j.shippers,"shipper","Nothing earned yet.");list($("mShops"),j.shops,"shop","No goods sold through M-Pesa yet.");
  var h=$("mHist");h.textContent="";if(!j.payouts.length)h.appendChild(el("p","note","No payouts recorded yet."));
  j.payouts.forEach(function(p){h.appendChild(moneyRow(p.label,new Date(p.at||p.created).toLocaleDateString("en-KE")+(p.note?" · "+p.note:""),fmt(p.amount)))})},function(e){toast(e.message)})}

/* Review: owner shops waiting for approval (admin: everywhere, sub-admin: their areas) */
function renderRShops(){var box=$("rShops");return api("GET","/review/shops").then(function(j){box.textContent="";if(!j.shops.length)return;
  var c=el("div","card");c.appendChild(el("b",null,"Shops waiting for approval ("+j.shops.length+")"));
  j.shops.forEach(function(s){var b=el("button","btn sec","Approve");b.type="button";b.style.cssText="margin:0;padding:6px 12px;width:auto";
    b.onclick=function(){b.disabled=true;api("POST","/review/shops/"+s.id+"/approve").then(function(){toast("Shop approved");renderRShops()},function(e){b.disabled=false;toast(e.message)})};
    c.appendChild(moneyRow(s.name+" ("+s.area+")",s.owner+" · "+s.phone+" · "+s.goods+" goods listed",null,b))});box.appendChild(c)},function(){})}

/* Admin: sub-admins */
var subChosen={};
function areaChecks(box,chosen,onchange){box.textContent="";order().forEach(function(a){var l=el("label",chosen[a]?"on":""),i=document.createElement("input");i.type="checkbox";i.checked=!!chosen[a];
  i.onchange=function(){if(i.checked)chosen[a]=1;else delete chosen[a];l.classList.toggle("on",i.checked);if(onchange)onchange()};l.appendChild(i);l.appendChild(document.createTextNode(a));box.appendChild(l)})}
function drawSubs(list){var box=$("sbList");box.textContent="";
  if(!list.length){box.appendChild(el("div","card empty","No sub-admins yet."));return}
  list.forEach(function(u){var c=el("div","card"),ch={};u.areas.forEach(function(a){ch[a]=1});c.appendChild(el("b",null,u.name));c.appendChild(document.createElement("br"));c.appendChild(el("small",null,u.email+" · "+u.phone));
    var cb=el("div","chk");areaChecks(cb,ch);c.appendChild(cb);var sv=el("button","btn sec","Save areas"),rm=el("button","btn sec dng","Remove sub-admin"),armed=false;
    sv.onclick=function(){var a=Object.keys(ch);if(!a.length){toast("Choose at least one area.");return}api("PUT","/admin/subs/"+u.id,{areas:a}).then(function(j){toast("Saved");drawSubs(j.subs)},function(e){toast(e.message)})};
    rm.onclick=function(){if(!armed){armed=true;rm.textContent="Tap again to remove";setTimeout(function(){armed=false;rm.textContent="Remove sub-admin"},3000);return}api("DELETE","/admin/subs/"+u.id).then(function(j){toast("Removed");drawSubs(j.subs)},function(e){toast(e.message)})};
    c.appendChild(sv);c.appendChild(rm);box.appendChild(c)})}
function renderSubs(){areaChecks($("sbAreas"),subChosen);return api("GET","/admin/subs").then(function(j){drawSubs(j.subs)},function(e){toast(e.message)})}
$("sbAdd").addEventListener("click",function(){var em=$("sb-email").value.trim().toLowerCase(),a=Object.keys(subChosen);$("sbErr").textContent="";
  if(!emailOk(em)){$("sbErr").textContent="Enter their email address.";return}if(!a.length){$("sbErr").textContent="Choose at least one area.";return}
  api("POST","/admin/subs",{email:em,areas:a}).then(function(j){$("sb-email").value="";subChosen={};areaChecks($("sbAreas"),subChosen);toast("Sub-admin added");drawSubs(j.subs)},function(e){$("sbErr").textContent=e.message})});

/* Slogans */
var SLG=["Si lazima uende dukani"],si=0;
function slg(){document.querySelectorAll("[data-slg]").forEach(function(e){e.textContent=SLG[si]})}
function tick(){var a=document.querySelectorAll("[data-slg]");a.forEach(function(e){e.classList.add("off")});setTimeout(function(){si=(si+1)%SLG.length;slg();a.forEach(function(e){e.classList.remove("off")})},400)}

/* Profile */
function fillProfile(){$("p-role").value=me.role==="admin"?"Administrator":me.role==="owner"?"Shop owner":me.role==="subadmin"?"Sub-admin · "+(me.areas||[]).join(", "):me.role==="shipper"?"Shipper · "+me.veh+" · "+me.area+" · "+({approved:"Verified",pending:"Under review",rejected:"Needs changes",draft:"ID needed"}[me.status]||""):"Sender";
  var lk=me.role==="shipper"&&(me.status==="pending"||me.status==="approved");$("p-name").readOnly=lk;$("p-lock").style.display=lk?"block":"none";$("p-name").value=me.name;$("p-phone").value=me.phone;$("p-email").value=me.email;$("pErr").textContent=""}
$("pSave").addEventListener("click",function(){var n=$("p-name").value.trim(),p=$("p-phone").value.trim();
  if(n.length<2){$("pErr").textContent="Enter your full name.";return}if(!phoneOk(p)){$("pErr").textContent="Enter a valid phone number.";return}
  api("PATCH","/me",{name:n,phone:p}).then(function(j){me=j.user;$("pErr").textContent="";toast("Profile saved")}).catch(function(e){$("pErr").textContent=e.message})});

/* Shipper identity verification: details + ID photos, then an admin decides */
var DOCS={front:"ID photo: front",back:"ID photo: back",selfie:"Selfie holding your ID"};
function renderVerify(){var st=me.status,edit=st==="draft"||st==="rejected";
  var T={draft:["Verify your identity","Add your ID details and photos. An admin reviews them before you can see jobs."],pending:["Under review","Thanks! An admin is checking your ID. We will email you as soon as it is decided."],rejected:["Changes needed",""]}[st]||["Verify your identity",""];
  $("vT").textContent=T[0];$("vS").textContent=st==="rejected"?"Reason: "+(me.rejectReason||"not given")+". Fix it below and submit again.":T[1];
  $("vForm").style.display=edit?"block":"none";$("vWait").style.display=edit?"none":"block";
  if(edit){$("v-idt").value=me.idType||ID_TYPES[0];$("v-idn").value=me.idNumber||"";$("v-dob").value=me.dob||"";$("v-addr").value=me.address||"";$("vErr").textContent="";renderDocs()}}
function renderDocs(){var box=$("v-docs");box.textContent="";
  (($("v-idt").value==="Passport")?["front","selfie"]:["front","back","selfie"]).forEach(function(k){
    var has=me.docs.indexOf(k)>-1,d=el("div","doc"+(has?" ok":"")),h=el("div","h"),inp=document.createElement("input"),b=el("button","btn sec",has?"Replace photo":"Choose photo");
    h.appendChild(el("span",null,DOCS[k]));if(has)h.appendChild(el("small",null,"✓ Uploaded"));d.appendChild(h);
    if(has){var im=el("img","docimg");im.alt=DOCS[k];im.src="/api/me/id-docs/"+k+"?v="+(docVer[k]||0);im.onclick=function(){im.classList.toggle("big")};d.appendChild(im)}
    inp.type="file";inp.accept="image/*";if(k==="selfie")inp.setAttribute("capture","user");
    b.type="button";b.onclick=function(){inp.click()};inp.onchange=function(){var f=inp.files&&inp.files[0];if(f)uploadDoc(k,f)};
    d.appendChild(b);d.appendChild(inp);box.appendChild(d)})}
/* shrink and re-encode as JPEG in the browser: faster upload on mobile data, and one predictable format for the server to check */
function prep(file){return new Promise(function(res,rej){var fr=new FileReader();
  fr.onerror=function(){rej(new Error("Could not read that file."))};
  fr.onload=function(){var im=new Image();im.onerror=function(){rej(new Error("That file is not a photo we can read."))};
    im.onload=function(){var s=Math.min(1,1600/Math.max(im.width,im.height)),c=document.createElement("canvas");c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);
      c.getContext("2d").drawImage(im,0,0,c.width,c.height);c.toBlob(function(b){b?res(b):rej(new Error("Could not process that photo."))},"image/jpeg",.85)};
    im.src=fr.result};fr.readAsDataURL(file)})}
function uploadDoc(k,f){if(busy)return;busy=true;$("vErr").textContent="";toast("Uploading…");
  prep(f).then(function(blob){return fetch("/api/me/id-docs/"+k,{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"image/jpeg"},body:blob})})
  .then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok)throw new Error(j.error||"Upload failed.");return j})})
  .then(function(j){me.docs=j.docs;docVer[k]=Date.now();busy=false;renderDocs();toast("Photo saved")})
  .catch(function(e){busy=false;renderDocs();$("vErr").textContent=e.message})}
$("v-idt").addEventListener("change",renderDocs);
$("vSubmit").addEventListener("click",function(){if(busy)return;var b=$("vSubmit");busy=true;b.disabled=true;$("vErr").textContent="";
  api("POST","/me/verification",{idType:$("v-idt").value,idNumber:$("v-idn").value.trim(),dob:$("v-dob").value,address:$("v-addr").value.trim()})
  .then(function(j){me=j.user;busy=false;b.disabled=false;navFor(me);toast("Submitted. We will email you the decision.");renderVerify()})
  .catch(function(e){busy=false;b.disabled=false;$("vErr").textContent=e.message})});

/* Admin: review shippers */
$("aTabs").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;adminTab=b.dataset.t;
  document.querySelectorAll("#aTabs button").forEach(function(x){x.classList.toggle("on",x===b)});renderAdmin()});
function ageOf(d){var b=new Date(d+"T00:00:00Z"),n=new Date(),a=n.getUTCFullYear()-b.getUTCFullYear();if(n.getUTCMonth()<b.getUTCMonth()||(n.getUTCMonth()===b.getUTCMonth()&&n.getUTCDate()<b.getUTCDate()))a--;return a}
function decideShipper(s,act,reason,btn){btn.disabled=true;
  api("POST","/admin/shippers/"+s.id+"/"+act,reason?{reason:reason}:{}).then(function(){toast(s.name+(act==="approve"?" approved":" rejected"))},function(e){toast(e.message)}).then(function(){renderAdmin()})}
function shipperCard(s){var c=el("div","card"),top=el("div"),l=el("div");top.style.cssText="display:flex;justify-content:space-between;align-items:center;gap:8px";
  l.appendChild(el("b",null,s.name));l.appendChild(document.createElement("br"));l.appendChild(el("small",null,s.email));top.appendChild(l);
  top.appendChild(el("span",s.status==="approved"?"pill d":s.status==="rejected"?"pill p":"pill",s.status));c.appendChild(top);
  var R=[["Phone",s.phone],["Vehicle",s.veh+" · base "+s.area],["ID",s.idType+" · "+s.idNumber],["Born",s.dob+" (age "+ageOf(s.dob)+")"],["Address",s.address],["Applied",new Date(s.at).toLocaleString()]];
  if(s.reason)R.push(["Reason",s.reason]);
  R.forEach(function(r){var p=el("div","kv");p.appendChild(el("b",null,r[0]+": "));p.appendChild(document.createTextNode(r[1]));c.appendChild(p)});
  ["front","back","selfie"].forEach(function(k){if(s.docs.indexOf(k)<0)return;var t=el("div","kv",DOCS[k]);t.style.marginTop="10px";c.appendChild(t);
    var im=el("img","docimg");im.alt=DOCS[k];im.src="/api/admin/shippers/"+s.id+"/docs/"+k;im.onclick=function(){im.classList.toggle("big")};c.appendChild(im)});
  if(s.status!=="approved"){var ap=el("button","btn ok","Approve");ap.onclick=function(){decideShipper(s,"approve",null,ap)};c.appendChild(ap)}
  if(s.status!=="rejected"){var rj=el("button","btn sec dng","Reject…"),w=el("div"),inp=el("input"),cf=el("button","btn sec dng","Confirm reject");
    w.style.display="none";inp.maxLength=200;inp.placeholder="Reason the shipper will see (e.g. photo is blurry)";inp.style.marginTop="8px";inp.setAttribute("aria-label","Rejection reason");w.appendChild(inp);w.appendChild(cf);
    rj.onclick=function(){w.style.display=w.style.display==="none"?"block":"none";if(w.style.display==="block")inp.focus()};
    cf.onclick=function(){if(inp.value.trim().length<3){toast("Give the shipper a reason (at least 3 characters).");return}decideShipper(s,"reject",inp.value.trim(),cf)};
    c.appendChild(rj);c.appendChild(w)}
  return c}
function renderAdmin(auto){var box=$("alist");var hp=document.querySelector("#v-admin .hero p");if(hp)hp.textContent=me.role==="subadmin"?"You review shippers and shops in: "+(me.areas||[]).join(", ")+".":"Check each shipper's details and ID photos before they can see jobs.";renderRShops();
  if(auto&&(box.contains(document.activeElement)||box.querySelector(".docimg.big")))return; /* do not disturb a review in progress */
  return api("GET","/admin/shippers?status="+adminTab).then(function(j){
    document.querySelectorAll("#aTabs button").forEach(function(b){b.textContent=b.dataset.t.charAt(0).toUpperCase()+b.dataset.t.slice(1)+" ("+j.counts[b.dataset.t]+")"});
    box.textContent="";if(!j.shippers.length){box.appendChild(el("div","card empty","Nobody here right now."));return}
    j.shippers.forEach(function(s){box.appendChild(shipperCard(s))})},function(e){toast(e.message)})}

/* Admin: shops and price lists */
function numIn(v){var n=Math.round(Number(v));return isFinite(n)?n:NaN}
function shopCall(method,path,body,done){return api(method,path,body).then(function(){if(done)done()},function(e){toast(e.message)}).then(renderShops)}
function lbl(t,id){var l=el("label",null,t);if(id)l.htmlFor=id;return l}
function itemEditor(sh,it){var d=el("div","ied"),r=el("div","row"),nm=el("input"),un=el("input"),pr=el("input"),r2=el("div","row"),bt=el("div","btns");
  nm.value=it?it.name:"";nm.maxLength=60;nm.placeholder="Item (e.g. Sugar)";nm.setAttribute("aria-label","Item name");
  un.value=it?it.unit:"";un.maxLength=20;un.placeholder="Unit (e.g. 1 kg)";un.setAttribute("aria-label","Unit");
  pr.type="number";pr.inputMode="numeric";pr.min="1";pr.value=it?it.price:"";pr.placeholder="Price KES";pr.setAttribute("aria-label","Price in shillings");
  r.style.gridTemplateColumns="1fr";r.appendChild(nm);d.appendChild(r);r2.appendChild(un);r2.appendChild(pr);d.appendChild(r2);
  function body(){var p=numIn(pr.value);if(nm.value.trim().length<2||!un.value.trim()||!(p>0)){toast("Fill in the item, unit and a price.");return null}return{name:nm.value.trim(),unit:un.value.trim(),price:p}}
  if(it){var sv=el("button","btn sec","Save"),hd=el("button","btn sec",it.active?"Hide":"Show"),rm=el("button","btn sec dng","Delete"),armed=false;
    sv.onclick=function(){var b=body();if(b)shopCall("PATCH","/admin/items/"+it.id,b,function(){toast("Saved")})};
    hd.onclick=function(){shopCall("PATCH","/admin/items/"+it.id,{active:!it.active})};
    rm.onclick=function(){if(!armed){armed=true;rm.textContent="Tap again";setTimeout(function(){armed=false;rm.textContent="Delete"},3000);return}shopCall("DELETE","/admin/items/"+it.id)};
    bt.style.gridTemplateColumns="repeat(3,1fr)";bt.appendChild(sv);bt.appendChild(hd);bt.appendChild(rm);if(!it.active)nm.style.opacity=".55"}
  else{var ad=el("button","btn","Add item");ad.style.marginTop="6px";ad.onclick=function(){var b=body();if(b)shopCall("POST","/admin/shops/"+sh.id+"/items",b,function(){toast("Item added")})};bt.style.gridTemplateColumns="1fr";bt.appendChild(ad)}
  d.appendChild(bt);return d}
function adminShopCard(sh){var c=el("div","card"),top=el("div"),l=el("div"),open=!!shopOpen[sh.id];top.style.cssText="display:flex;justify-content:space-between;align-items:center;gap:8px";
  l.appendChild(el("b",null,sh.name));l.appendChild(document.createElement("br"));l.appendChild(el("small",null,sh.area+" · "+sh.items.length+" goods"));top.appendChild(l);
  var tg=el("div");tg.style.cssText="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end";tg.appendChild(el("span",sh.rec?"tag":"tag off",sh.rec?"⭐ Recommended":"Not recommended"));if(sh.owned)tg.appendChild(el("span","tag","🏪 Owner"));if(!sh.active)tg.appendChild(el("span",sh.owned?"tag warn":"tag off",sh.owned?"Awaiting approval":"Hidden"));top.appendChild(tg);c.appendChild(top);
  var m=el("div","mini"),a=el("button","btn sec",sh.rec?"Unrecommend":"Recommend"),h=el("button","btn sec",sh.active?"Hide shop":sh.owned?"Approve shop":"Show shop"),x=el("button","btn sec dng","Delete"),armed=false;
  a.onclick=function(){shopCall("PATCH","/admin/shops/"+sh.id,{rec:!sh.rec})};h.onclick=function(){shopCall("PATCH","/admin/shops/"+sh.id,{active:!sh.active})};
  x.onclick=function(){if(!armed){armed=true;x.textContent="Tap again";setTimeout(function(){armed=false;x.textContent="Delete"},3000);return}shopCall("DELETE","/admin/shops/"+sh.id,null,function(){toast("Shop deleted")})};
  m.appendChild(a);m.appendChild(h);m.appendChild(x);c.appendChild(m);
  var t=el("button","btn sec",open?"Hide goods ▲":"Goods & prices ▼");t.onclick=function(){shopOpen[sh.id]=!open;drawShops()};c.appendChild(t);
  if(open){sh.items.forEach(function(it){c.appendChild(itemEditor(sh,it))});var nb=el("b",null,"Add a good");nb.style.cssText="display:block;margin-top:12px;font-size:13px";c.appendChild(nb);c.appendChild(itemEditor(sh,null))}
  return c}
function drawShops(){var box=$("slist"),f=$("sf").value,list=adminShops.filter(function(s){return f==="all"||s.area===f});box.textContent="";
  if(!list.length){box.appendChild(el("div","card empty","No shops here yet. Add one above."));return}list.forEach(function(s){box.appendChild(adminShopCard(s))})}
function renderShops(){return api("GET","/admin/shops").then(function(j){adminShops=j.shops;drawShops()},function(e){toast(e.message)})}
$("sf").addEventListener("change",drawShops);
$("ns-add").addEventListener("click",function(){var n=$("ns-name").value.trim();$("nsErr").textContent="";if(n.length<2){$("nsErr").textContent="Enter the shop name.";return}
  api("POST","/admin/shops",{area:$("ns-area").value,name:n}).then(function(j){$("ns-name").value="";shopOpen[j.id]=true;toast("Shop added. Now add its goods.");$("sf").value="all";return renderShops()}).catch(function(e){$("nsErr").textContent=e.message})});

/* Request form (senders) */
/* Recommended shops (from the admin's catalog) come first in each area, then the sender's own saved shops, then "Other" */
function curShop(){var v=$("shopSel").value;if(v.indexOf("c:")!==0)return null;var id=+v.slice(2);return catalog.filter(function(x){return x.id===id})[0]||null}
function loadCatalog(){return api("GET","/shops").then(function(j){if(JSON.stringify(j)!==JSON.stringify(catalog)){catalog=j;fillShops()}},function(){})}
function fillShops(){var a=$("from").value,s=$("shopSel"),keep=s.value;s.textContent="";
  catalog.filter(function(x){return x.area===a}).forEach(function(x){s.add(new Option((x.rec?"⭐ ":"")+x.name,"c:"+x.id))});
  myShops.filter(function(x){return x.a===a}).forEach(function(x){s.add(new Option(x.n,"m:"+x.n))});
  s.add(new Option("✏️ Other: type a shop name",OTHER));
  if(keep&&Array.prototype.some.call(s.options,function(o){return o.value===keep}))s.value=keep;shopToggle()}
function shopToggle(){$("otherWrap").style.display=$("shopSel").value===OTHER?"block":"none";renderGoods()}
function cartCount(){var n=0;for(var k in cart)n+=cart[k];return n}
function cartLines(){var cs=curShop(),o=[];if(!cs)return o;cs.items.forEach(function(i){if(cart[i.id])o.push({id:i.id,q:cart[i.id]})});return o}
function goodsSum(){var cs=curShop(),t=0;if(cs)cs.items.forEach(function(i){t+=i.price*(cart[i.id]||0)});return t}
function renderGoods(){var cs=curShop(),box=$("goods");if((cs?cs.id:null)!==cartShop){cart={};cartShop=cs?cs.id:null}
  box.textContent="";$("goodsCard").style.display=cs&&cs.items.length?"block":"none";
  $("l-it").textContent=cs&&cs.items.length?"Other items not on the list (optional)":"Item name";
  syncPay();
  if(cs)cs.items.forEach(function(i){var row=el("div","gi"+(cart[i.id]?" on":"")),t=el("div","gt"),q=el("div","qty"),m=el("button",null,"−"),n=el("span",null,String(cart[i.id]||0)),p=el("button",null,"+");
    t.appendChild(el("b",null,i.name));t.appendChild(el("small",null,i.unit+" · "+fmt(i.price)));m.type="button";p.type="button";m.setAttribute("aria-label","Less "+i.name);p.setAttribute("aria-label","More "+i.name);
    function set(v){v=Math.max(0,Math.min(50,v));if(v)cart[i.id]=v;else delete cart[i.id];n.textContent=String(v);row.classList.toggle("on",v>0);m.disabled=!v;showTotal()}
    m.disabled=!cart[i.id];m.onclick=function(){set((cart[i.id]||0)-1)};p.onclick=function(){set((cart[i.id]||0)+1)};
    q.appendChild(m);q.appendChild(n);q.appendChild(p);row.appendChild(t);row.appendChild(q);box.appendChild(row)});
  showTotal()}
/* Checkout payment choice: pay on delivery, or pay now with an M-Pesa STK Push (only offered when the server has Daraja configured) */
function syncPay(){var cs=curShop(),hasGoods=!!(cs&&cs.items.length),g=goodsSum(),lat=hasGoods&&g>DEFER_MIN,total=(lastQ?lastQ.total:0)+g;
  if(payMethod==="later"&&!lat)payMethod="mpesa";if(!MPESA)payMethod="cod";
  $("payWrap").style.display=MPESA?"block":"none";$("mpWrap").style.display=MPESA?"block":"none";
  var lb=document.querySelector('#payM [data-p="later"]');lb.style.display=lat?"":"none";$("payM").style.gridTemplateColumns=lat?"":"1fr";
  document.querySelectorAll("#payM button").forEach(function(b){b.classList.toggle("on",b.dataset.p===payMethod)});
  var later=payMethod==="later";
  $("payNote").textContent=!MPESA?(hasGoods?"💵 Pay on delivery. Goods are priced per unit and added to the delivery fee. Anything you type in yourself is not priced yet.":"💵 Pay on delivery. Item cost is not included: this is the delivery fee only.")
    :later?"🤝 Your request goes to shippers now. After you confirm you have received your goods you pay "+fmt(total)+" by M-Pesa."
    :"📲 You will get an M-Pesa PIN prompt on your phone. Your request goes to shippers once the payment is received."+(hasGoods?(g>DEFER_MIN?"":" Goods above "+fmt(DEFER_MIN)+" from a listed shop can be paid for after delivery."):" Item cost is not included: this is the delivery fee only.");
  $("submit").textContent=later?"Send request (pay after delivery)":MPESA?"Pay "+fmt(total)+" & request":"Submit request"}
$("payM").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;payMethod=b.dataset.p;if(!$("mpPhone").value&&me)$("mpPhone").value=me.phone;syncPay()});
function showTotal(){if(!lastQ)return;var g=goodsSum(),typed=$("it").value.trim().length>1,cs=curShop();countTo(lastQ.total+g);syncPay();
  $("sumLine").textContent=cs&&cs.items.length?"Delivery "+fmt(lastQ.total)+" + Goods "+fmt(g)+(typed?" + typed items (not priced)":""):"Delivery fee only";}
$("it").addEventListener("input",showTotal);
function fill(){var f=$("from"),t=$("to"),j=$("jf"),aa=$("a-area");order().forEach(function(c){f.add(new Option(c,c));t.add(new Option(c,c));j.add(new Option(c,c));aa.add(new Option(c,c));$("a-oarea").add(new Option(c,c));$("nbArea").add(new Option(c,c));$("ns-area").add(new Option(c,c));$("sf").add(new Option(c,c))});
  j.add(new Option("All areas","all"),0);j.value="all";$("sf").add(new Option("All areas","all"),0);$("sf").value="all";f.value="Mombasa";t.value="Diani";try{var la=localStorage.getItem("smd_area");$("nbArea").value=AREAS[la]?la:"Mombasa"}catch(e){$("nbArea").value="Mombasa"}
  WT.forEach(function(w,i){$("wt").add(new Option(w.l,i))});VEHICLES.forEach(function(v){$("a-veh").add(new Option(v,v))});ID_TYPES.forEach(function(v){$("a-idt").add(new Option(v,v));$("v-idt").add(new Option(v,v))});fillShops()}
var lastTotal=0;
function countTo(n){var e=$("total"),s=lastTotal,st=performance.now();lastTotal=n;(function step(t){var p=Math.min(1,(t-st)/450);e.textContent=fmt(Math.round(s+(n-s)*p));if(p<1)requestAnimationFrame(step)})(st)}
function updatePrice(){var f=$("from").value,t=$("to").value,q=quote(f,t,+$("wt").value,speed);
  lastQ=q;showTotal();$("dist").textContent=f===t?"Within "+f:"≈ "+q.d+" km · "+f+" → "+t;
  var sum=q.route+q.wf+q.ex+q.ferry;[["b1",q.route],["b2",q.wf],["b3",q.ex],["b4",q.ferry]].forEach(function(r){$(r[0]).style.width=(r[1]/sum*100)+"%"});
  $("l1").textContent=q.route;$("l2").textContent=q.wf;$("l3").textContent=q.ex;$("l4").textContent=q.ferry;drawMap($("formMap"),f,t)}
$("from").addEventListener("change",function(){fillShops();updatePrice()});
["to","wt"].forEach(function(i){$(i).addEventListener("change",updatePrice)});
$("shopSel").addEventListener("change",shopToggle);
$("spd").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;speed=b.dataset.s;
  document.querySelectorAll("#spd button").forEach(function(x){x.classList.toggle("on",x===b)});updatePrice()});
$("submit").addEventListener("click",function(){
  if(!me||me.role!=="sender"||busy)return;
  var ids=["shopOther","drop","it","rn","rp"],bad=[],other=$("shopSel").value===OTHER;ids.forEach(function(k){$(k).classList.remove("bad")});
  if(other&&$("shopOther").value.trim().length<2)bad.push("shopOther");
  ["drop","rn"].forEach(function(k){if($(k).value.trim().length<2)bad.push(k)});
  if(!cartCount()&&$("it").value.trim().length<2)bad.push("it");
  if(!phoneOk($("rp").value))bad.push("rp");
  var mp=MPESA&&payMethod==="mpesa",lt=MPESA&&payMethod==="later";if((mp||lt)&&!phoneOk($("mpPhone").value))bad.push("mpPhone");
  if(bad.length){bad.forEach(function(k){$(k).classList.add("bad")});$("err").textContent="Please complete the highlighted fields. Phone looks like 0712 345 678.";$(bad[0]).focus();return}
  $("err").textContent="";
  var from=$("from").value,cs=curShop(),sv=$("shopSel").value,shop=other?$("shopOther").value.trim():cs?cs.name:sv.slice(2),btn=$("submit"),mpNum=$("mpPhone").value.trim();busy=true;btn.disabled=true;
  api("POST","/deliveries",{pay:mp?"mpesa":lt?"later":"cod",from:from,to:$("to").value,shop:shop,shopId:cs?cs.id:undefined,items:cs&&cartCount()?cartLines():undefined,custom:other,land:$("land").value.trim(),drop:$("drop").value.trim(),pp:pins.pick,dp:pins.drop,it:$("it").value.trim(),w:+$("wt").value,s:speed,rn:$("rn").value.trim(),rp:$("rp").value.trim()})
  .then(function(d){busy=false;btn.disabled=false;
    if(other&&!myShops.some(function(x){return x.a===from&&x.n.toLowerCase()===shop.toLowerCase()}))myShops.push({a:from,n:shop});
    ["shopOther","land","drop","it","rn","rp"].forEach(function(k){$(k).value=""});cart={};cartShop=null;fillShops();initPins();
    if(d.payState==="awaiting"){go("hist");renderList(false,d.id);runPay(d,mpNum);return} /* order saved; now ask the phone for payment */
    toast("Request sent! ID "+d.id);go("hist");renderList(false,d.id)})
  .catch(function(e){busy=false;btn.disabled=false;$("err").textContent=e.message})});

/* M-Pesa payment screen: send the STK Push, then poll until the callback (or a status query on the server) settles it */
function payView(o){var s=$("pbI");$("payBox").style.display="grid";s.textContent=o.icon;s.classList.toggle("spin",!!o.spin);$("pbT").textContent=o.title;$("pbS").textContent=o.sub||"";
  var ph=$("pbPhone");ph.style.display=o.phone!=null?"block":"none";if(o.phone!=null)ph.value=o.phone;
  [["pbMain",o.main],["pbAlt",o.alt],["pbClose",o.close]].forEach(function(x){var b=$(x[0]);b.style.display=x[1]?"block":"none";if(x[1]){b.textContent=x[1][0];b.disabled=false;b.onclick=x[1][1]}})}
function closePay(){clearInterval(payPoll);payPoll=null;$("payBox").style.display="none"}
function afterPay(d,msg){closePay();if(msg)toast(msg);go("hist");renderList(false,d.id)}
function askPay(d,phone,title,sub){payView({icon:"📲",title:title,sub:sub,phone:phone||(me?me.phone:""),
  main:["Send M-Pesa request",function(){var n=$("pbPhone").value.trim();if(!phoneOk(n)){$("pbS").textContent="Enter a valid Safaricom number, e.g. 0712 345 678.";return}runPay(d,n)}],
  alt:d.laterOk?["Pay after delivery instead",function(){$("pbAlt").disabled=true;api("POST","/deliveries/"+encodeURIComponent(d.id)+"/later").then(function(){afterPay(d,"Switched to pay after delivery. ID "+d.id)},function(e){afterPay(d);toast(e.message)})}]:null,
  close:["Not now",function(){afterPay(d,"Saved. Tap Pay when you are ready.")}]})}
function runPay(d,phone){payView({icon:"📲",title:"Sending request…",sub:"Contacting M-Pesa.",spin:true});
  api("POST","/deliveries/"+encodeURIComponent(d.id)+"/pay",{phone:phone}).then(function(r){
    payView({icon:"📲",title:"Check your phone",sub:"Enter your M-Pesa PIN to pay "+fmt(r.amount)+" from "+r.phone+". Keep this screen open.",spin:true});watchPay(d,phone)},
    function(e){if(e.status===409&&/already open/.test(e.message))return watchPay(d,phone,true);askPay(d,phone,"Could not start payment",e.message)})}
function watchPay(d,phone,resumed){var t0=Date.now(),inflight=false;clearInterval(payPoll);
  if(resumed)payView({icon:"📲",title:"Check your phone",sub:"A payment request is already open on your phone. Enter your PIN to complete it.",spin:true});
  payPoll=setInterval(function(){if(inflight)return;inflight=true;
    api("GET","/deliveries/"+encodeURIComponent(d.id)+"/payment").then(function(j){inflight=false;
      if(!payPoll)return;
      if(j.state==="success"){clearInterval(payPoll);payView({icon:"✅",title:"Payment received",sub:"M-Pesa receipt "+(j.receipt||"")+". Shippers can now see your request.",main:["Track my request",function(){afterPay(d,"Paid. ID "+d.id)}]});return}
      if(j.state!=="pending"&&j.state!=="initiating"){clearInterval(payPoll);askPay(d,phone,"Payment not completed",j.message||"The payment was not completed.");return}
      if(Date.now()-t0>170000){clearInterval(payPoll);payView({icon:"⏳",title:"Still waiting",sub:"We have not heard back from M-Pesa yet. If money left your account, your request will update on its own within a few minutes.",close:["Close",function(){afterPay(d)}]})}
    },function(){inflight=false})},3000)}

function pillCls(s){return "pill"+(s===2?" d":s===0?" p":"")}
function copyBtn(id){var b=el("button","btn sec","Copy tracking ID");b.addEventListener("click",function(e){e.stopPropagation();try{navigator.clipboard.writeText(id).then(function(){toast("Copied "+id)},function(){toast(id)})}catch(er){toast(id)}});return b}
function card(x,open,ctx){ /* ctx: s = sender, j = shipper job board, m = shipper's own jobs */
  var c=el("div","card item"+(open?" open":"")),top=el("div","top"),l=el("div");
  l.appendChild(el("b",null,x.from+" → "+x.to));l.appendChild(document.createElement("br"));l.appendChild(el("small",null,x.id+" · "+x.shop));
  top.appendChild(l);top.appendChild(el("span",pillCls(x.step),STEPS[x.step]));c.appendChild(top);
  var dt=el("div","detail"),svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 320 210");svg.setAttribute("width","100%");dt.appendChild(svg);
  var ul=el("ul","tl");STEPS.forEach(function(s,i){var li=el("li",i<=x.step?"done":"");li.appendChild(el("i",null,i<=x.step?"✓":""));li.appendChild(document.createTextNode(s));ul.appendChild(li)});dt.appendChild(ul);
  var R=[["Pickup",x.shop+", "+x.from+(x.land?" ("+x.land+")":"")],["Drop-off",x.drop?x.drop+", "+x.to:x.to+" (exact spot shown after you accept)"],["Item",(x.items&&x.items.length?"":x.it+" · ")+WT[x.w].l+" · "+(x.s==="express"?"Express":"Standard")]];
  if(ctx==="s")R.splice(2,0,["Recipient",x.rn+" · "+x.rp],["Shipper",x.shipper?x.shipperName+" · "+x.shipperPhone+" ("+x.veh+")":"Waiting for a shipper"]);
  if(ctx==="m")R.splice(2,0,["Recipient",x.rn+" · "+x.rp],["Sender",x.sn+" · "+x.sp]);
  (x.items||[]).forEach(function(l){R.push([l.q+" × "+l.n+(l.u?" ("+l.u+")":""),fmt(l.p*l.q)])});
  if(x.custom&&x.items&&x.items.length)R.push(["Other items (not priced)",x.custom]);
  R.push(["Delivery fee",fmt(x.price)]);if(x.goods)R.push(["Goods",fmt(x.goods)]);
  R.push([ctx==="s"?(x.payState==="paid"?"Total (paid)":x.payState==="awaiting"?"Total (unpaid)":x.payState==="later"?"Total (pay after delivery)":"Total (pay on delivery)"):"Total",fmt(x.price+x.goods)]);
  if(ctx==="s"||ctx==="m"){if(x.payState==="paid")R.push(["Payment","Paid with M-Pesa"+(x.receipt?" · "+x.receipt:"")]);else if(x.payState==="awaiting")R.push(["Payment","M-Pesa payment not completed"]);else if(x.payState==="later")R.push(["Payment",ctx==="s"?"M-Pesa after you confirm you received it":"The sender pays by M-Pesa after confirming receipt"]);else R.push(["Payment","On delivery"])}
  if(ctx==="m"&&(x.payState==="paid"||x.payState==="later"))R.push(["Collect from recipient","Nothing: "+(x.payState==="paid"?"already paid by M-Pesa":"the sender pays through the app")]);
  R.forEach(function(r){var p=el("div");p.style.cssText="font-size:13px;margin:3px 0";var b=el("b",null,r[0]+": ");b.style.fontSize="13px";p.appendChild(b);p.appendChild(document.createTextNode(r[1]));dt.appendChild(p)});
  if(x.pp)dt.appendChild(pinChip(x.pp,"Pickup pin",ctx!=="s"));if(x.dp)dt.appendChild(pinChip(x.dp,"Drop-off pin",ctx!=="s"));
  if(ctx==="j"){var a=el("button","btn","Accept job");a.addEventListener("click",function(e){e.stopPropagation();a.disabled=true;
    api("POST","/jobs/"+encodeURIComponent(x.id)+"/accept").then(function(){toast("Job accepted. See My jobs.")},function(er){toast(er.message)}).then(renderJobs)});dt.appendChild(a)}
  if(ctx==="m"){var f=el("button","btn",x.step===2?"Completed ✓":x.shipOk?"Waiting for sender to confirm":"Mark as delivered");f.disabled=x.step!==1||x.shipOk;f.addEventListener("click",function(e){e.stopPropagation();f.disabled=true;
    api("POST","/jobs/"+encodeURIComponent(x.id)+"/deliver").then(function(j){toast(j.done?"Delivery completed":"Signed off. Waiting for the sender to confirm.")},function(er){toast(er.message)}).then(function(){renderMine(x.id)})});dt.appendChild(f)}
  if(ctx==="s"&&x.step===0&&x.payState==="awaiting"&&MPESA){var pb=el("button","btn","Pay "+fmt(x.price+x.goods)+" with M-Pesa");pb.addEventListener("click",function(e){e.stopPropagation();askPay(x,me.phone,"Pay with M-Pesa","We will send a PIN prompt for "+fmt(x.price+x.goods)+" to this number.")});dt.appendChild(pb)}
  if(ctx==="s"&&x.step===1&&x.payState==="later"&&x.ownOk&&MPESA){var lp=el("button","btn","Pay "+fmt(x.price+x.goods)+" with M-Pesa");lp.addEventListener("click",function(e){e.stopPropagation();askPay(x,me.phone,"Pay with M-Pesa","We will send a PIN prompt for "+fmt(x.price+x.goods)+" to this number.")});dt.appendChild(lp)}
  if(ctx==="s"&&x.step===1&&!x.ownOk){var g=el("button","btn",x.payState==="later"?"Confirm I received it, then pay":"Confirm I received it");g.addEventListener("click",function(e){e.stopPropagation();g.disabled=true;
    api("POST","/deliveries/"+encodeURIComponent(x.id)+"/confirm").then(function(j){if(j.needPay){go("hist");renderList(false,x.id);askPay(x,me.phone,"Pay with M-Pesa","Thanks for confirming. We will send a PIN prompt for "+fmt(x.price+x.goods)+" to this number.");return}toast(j.done?"Delivery completed":"Confirmed. Waiting for the shipper to sign off.");renderList(false,x.id)},function(er){toast(er.message);renderList(false,x.id)})});dt.appendChild(g)}
  if(ctx==="s"&&x.step===1&&x.ownOk&&x.payState!=="later")dt.appendChild(el("p","note","You confirmed. Waiting for the shipper to sign off."));
  if(ctx==="s"&&x.step===1&&x.shipOk&&!x.ownOk)dt.appendChild(el("p","note","The shipper says this was delivered. Confirm once you or your recipient has it."));
  if(ctx==="s"&&x.step===2&&x.shipper){if(x.rating)dt.appendChild(starsRow("You rated this delivery ",x.rating));else dt.appendChild(rateBox(x))}
  dt.appendChild(copyBtn(x.id));
  if(ctx==="s"&&x.step===0){var b3=el("button","btn sec dng","Cancel request"),armed=false;b3.addEventListener("click",function(e){e.stopPropagation();
    if(!armed){armed=true;b3.textContent="Tap again to cancel "+x.id;setTimeout(function(){armed=false;b3.textContent="Cancel request"},4000);return}
    b3.disabled=true;api("DELETE","/deliveries/"+encodeURIComponent(x.id)).then(function(){toast("Request cancelled")},function(er){toast(er.message)}).then(function(){renderList(false)})});dt.appendChild(b3)}
  c.dataset.id=x.id;c.appendChild(dt);
  c.addEventListener("click",function(){c.classList.toggle("open");if(c.classList.contains("open"))drawMap(svg,x.from,x.to)});
  if(open)drawMap(svg,x.from,x.to);return c}

function fillBox(box,arr,ctx,msg,openId){var keep={};box.querySelectorAll(".item.open").forEach(function(n){keep[n.dataset.id]=1});box.textContent="";
  if(!arr.length){box.appendChild(el("div","card empty",msg));return}arr.forEach(function(x){box.appendChild(card(x,x.id===openId||!!keep[x.id],ctx))})}
function drawList(openId){var term=$("q").value.trim().toUpperCase();
  var d=cache.mine.filter(function(x){return !term||x.id.indexOf(term)>-1});
  fillBox($("list"),d,"s",term?"No delivery matches that ID.":"No deliveries yet. Tap Request to create one.",openId||(term&&d.length===1?d[0].id:""))}
var rlSeq=0;
function renderList(reset,openId){var q=$("q");if(reset&&!openId)q.value="";var n=++rlSeq;
  return api("GET","/deliveries").then(function(d){if(n!==rlSeq)return;cache.mine=d;drawList(openId)},function(e){toast(e.message)})}
$("q").addEventListener("input",function(){drawList()});
function renderJobs(){var a=$("jf").value;refreshMe();var rt=me&&me.rating,mn=me&&me.money;$("jRate").textContent=(rt?(rt.avg==null?"Your rating: none yet · "+rt.done+" delivered":"Your rating: "+starStr(rt.avg)+" "+rt.avg.toFixed(1)+" ("+rt.count+") · "+rt.done+" delivered"):"")+(mn&&mn.earned?" · Earned "+fmt(mn.earned)+" · waiting for payout "+fmt(mn.owed):"");return api("GET","/jobs?area="+encodeURIComponent(a)).then(function(d){cache.jobs=d;fillBox($("jlist"),d,"j","No open jobs right now. Check again soon.")},jerr)}
$("jf").addEventListener("change",renderJobs);
function renderMine(openId){return api("GET","/jobs/mine").then(function(d){cache.jm=d;fillBox($("mlist"),d,"m","You have no jobs yet. Accept one from Jobs.",openId)},jerr)}
function jerr(e){if(e.status===403)refreshMe();else toast(e.message)}
function bump(id,n){var e=$(id),s=+e.textContent,st=performance.now();(function step(t){var p=Math.min(1,(t-st)/500);e.textContent=Math.round(s+(n-s)*p);if(p<1)requestAnimationFrame(step)})(st)}
function renderHome(){loadNear();return api("GET","/deliveries").then(function(d){cache.mine=d;
  bump("s1",d.length);bump("s2",d.filter(function(x){return x.step<2}).length);bump("s3",d.filter(function(x){return x.step===2}).length);
  var r=$("recent");r.textContent="";
  if(!d.length){r.appendChild(el("div","empty","Your deliveries will show up here."));return}
  d.slice(0,3).forEach(function(x){var row=el("div","item");row.style.padding="10px 0";var t=el("div","top"),l=el("div");
    l.appendChild(el("b",null,x.from+" → "+x.to));l.appendChild(document.createElement("br"));l.appendChild(el("small",null,x.id+" · "+x.shop));
    t.appendChild(l);t.appendChild(el("span",pillCls(x.step),STEPS[x.step]));row.appendChild(t);
    row.addEventListener("click",function(){go("hist");renderList(false,x.id)});r.appendChild(row)})},function(e){toast(e.message)})}

/* Live refresh so shared jobs and status changes show up without reloading */
setInterval(function(){if(!me||document.hidden||busy)return;var v=document.querySelector(".view.on");if(!v)return;
  if(v.id==="v-hist")renderList(false);else if(v.id==="v-jobs")renderJobs();else if(v.id==="v-mine")renderMine();else if(v.id==="v-home")renderHome();else if(v.id==="v-verify")refreshMe();else if(v.id==="v-admin")renderAdmin(true)},15000);

/* Boot */
function init(){document.querySelector("header small").textContent=order().join(" \u00b7 ");fill();drawMap($("homeMap"));drawMap($("authMap"));setMode("login");slg();loadG();
  api("GET","/me").then(function(j){start(j.user,j.shops)},function(){show("auth")})}
fetch("/api/config",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(c){
  MPESA=!!c.mpesa;PUSH=!!c.push;VAPID=c.vapid||"";FEES=c.FEES||{};DEFER_MIN=c.DEFER_MIN||999;AREAS=c.AREAS;SHOPS=c.SHOPS;P=c.P;WT=c.WT;VEHICLES=c.VEHICLES;BOX=c.BOX;ID_TYPES=c.ID_TYPES||[];GOOGLE_CLIENT_ID=c.googleClientId||"";init()})
  .catch(function(){document.querySelector(".wrap").prepend(el("div","card empty","Cannot reach the SMD server. Please refresh."))});
/* Admin: delivery fees between places */
function renderFees(){return api("GET","/admin/fees").then(function(j){drawFees(j.fees)},function(e){toast(e.message)})}
function drawFees(list){var box=$("flist");box.textContent="";FEES={};
  list.forEach(function(r){if(r.fee!=null)FEES[feeKey(r.a,r.b)]=r.fee;
    var c=el("div","card"),t=el("div","top"),l=el("div"),title=r.a===r.b?"Within "+r.a:r.a+" ↔ "+r.b;
    l.appendChild(el("b",null,title));l.appendChild(document.createElement("br"));l.appendChild(el("small",null,r.fee!=null?"Your fee. Automatic would be "+fmt(r.auto):"Automatic fee"));
    t.appendChild(l);t.appendChild(el("span","tag"+(r.fee!=null?"":" off"),r.fee!=null?"Custom":"Auto"));c.appendChild(t);
    var row=el("div","row"),inp=document.createElement("input");inp.type="number";inp.min="10";inp.max="50000";inp.step="10";inp.inputMode="numeric";inp.value=r.fee!=null?r.fee:r.auto;inp.setAttribute("aria-label","Fee for "+title+" in KES");
    var save=el("button","btn","Save"),rs=el("button","btn sec","Use automatic");save.style.marginTop=rs.style.marginTop="0";
    var w1=el("div");w1.appendChild(inp);row.appendChild(w1);var w2=el("div");w2.appendChild(save);row.appendChild(w2);c.appendChild(row);
    if(r.fee!=null){c.appendChild(rs)}
    var err=el("div","err");err.setAttribute("role","alert");c.appendChild(err);
    save.addEventListener("click",function(){var v=Math.round(+inp.value);err.textContent="";if(!(v>=10&&v<=50000)){err.textContent="Enter a fee between 10 and 50,000.";return}save.disabled=true;
      api("PUT","/admin/fees",{a:r.a,b:r.b,fee:v}).then(function(j){toast("Saved: "+title+" "+fmt(v));drawFees(j.fees)},function(e){save.disabled=false;err.textContent=e.message})});
    rs.addEventListener("click",function(){rs.disabled=true;api("DELETE","/admin/fees",{a:r.a,b:r.b}).then(function(j){toast("Back to the automatic fee");drawFees(j.fees)},function(e){rs.disabled=false;err.textContent=e.message})});
    box.appendChild(c)})}
})();

/* Show/hide password: small eye button on every password box */
(function(){var i=document.getElementById("a-pw");if(!i||i.parentNode.classList.contains("pwbox"))return;
  var w=document.createElement("div");w.className="pwbox";i.parentNode.insertBefore(w,i);w.appendChild(i);
  var b=document.createElement("button");b.type="button";b.className="eye";b.setAttribute("aria-label","Show password");b.setAttribute("aria-pressed","false");
  var ON='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
      OFF='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a19 19 0 0 1 5.1-5.9M9.9 5.1A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/></svg>';
  b.innerHTML=ON;w.appendChild(b);
  b.addEventListener("click",function(){var show=i.type==="password";i.type=show?"text":"password";b.innerHTML=show?OFF:ON;b.setAttribute("aria-label",show?"Hide password":"Show password");b.setAttribute("aria-pressed",show?"true":"false");i.focus()})})();
