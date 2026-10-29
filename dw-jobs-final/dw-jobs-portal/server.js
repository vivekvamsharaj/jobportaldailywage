// ============================================================
//  Daily Wage Jobs Portal - ONE FILE (backend + frontend)
//  Languages: Telugu / English / Hindi
//  Workers see jobs within 10 km (adjustable) on a live map
// ============================================================
const express = require('express'), cors = require('cors'), mongoose = require('mongoose');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const MONGO = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dwjobs';
const PORT = process.env.PORT || 5000;

// ---------------- MODELS ----------------
const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['worker', 'employer'], required: true },
  address: String
}, { timestamps: true }));

const jobSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  category: String,
  address: String,
  wage: { type: Number, required: true },
  geo: { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], required: true } }, // [lng, lat]
  employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  open: { type: Boolean, default: true }
}, { timestamps: true });
jobSchema.index({ geo: '2dsphere' });
const Job = mongoose.model('Job', jobSchema);

const appSchema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' }
}, { timestamps: true });
appSchema.index({ job: 1, worker: 1 }, { unique: true });
const Application = mongoose.model('Application', appSchema);

// ---------------- HELPERS ----------------
const app = express();
app.use(cors()); app.use(express.json());
const h = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ msg: e.message }));
const sign = u => jwt.sign({ id: u._id, role: u.role, name: u.name }, SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ msg: 'Please login again' }); }
};
const role = r => (req, res, next) => req.user.role === r ? next() : res.status(403).json({ msg: 'Not allowed' });

// ---------------- API ----------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', h(async (req, res) => {
  const { name, phone, password, role: rl, address } = req.body;
  if (!name || !phone || !password || !rl) return res.status(400).json({ msg: 'Missing fields' });
  if (String(phone).length < 10) return res.status(400).json({ msg: 'Enter a valid phone number' });
  if (String(password).length < 4) return res.status(400).json({ msg: 'Password too short' });
  try {
    const u = await User.create({ name, phone, role: rl, address, password: await bcrypt.hash(password, 10) });
    res.json({ token: sign(u), user: { name: u.name, role: u.role } });
  } catch (e) { res.status(400).json({ msg: e.code === 11000 ? 'Phone already registered' : e.message }); }
}));

app.post('/api/auth/login', h(async (req, res) => {
  const u = await User.findOne({ phone: req.body.phone });
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password))) return res.status(400).json({ msg: 'Invalid phone or password' });
  res.json({ token: sign(u), user: { name: u.name, role: u.role } });
}));

// Jobs within radius (km) of the worker, nearest first
app.get('/api/jobs/nearby', h(async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const km = Math.min(parseFloat(req.query.radius) || 10, 50);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ msg: 'Location required' });
  const query = { open: true };
  if (req.query.category) query.category = req.query.category;
  const jobs = await Job.aggregate([{ $geoNear: {
    near: { type: 'Point', coordinates: [lng, lat] }, distanceField: 'distance',
    maxDistance: km * 1000, spherical: true, query } }]);
  await Job.populate(jobs, { path: 'employer', select: 'name phone' });
  res.json(jobs.map(j => ({ ...j, distanceKm: +(j.distance / 1000).toFixed(1) })));
}));

app.post('/api/jobs', auth, role('employer'), h(async (req, res) => {
  const { title, description, category, address, wage, lat, lng } = req.body;
  if (!title || !wage) return res.status(400).json({ msg: 'Title and wage required' });
  if (lat == null || lng == null) return res.status(400).json({ msg: 'Job location required' });
  res.json(await Job.create({ title, description, category, address, wage: Number(wage),
    geo: { type: 'Point', coordinates: [Number(lng), Number(lat)] }, employer: req.user.id }));
}));

app.get('/api/jobs/mine', auth, role('employer'), h(async (req, res) =>
  res.json(await Job.find({ employer: req.user.id }).sort('-createdAt'))));

app.get('/api/jobs/:id/applicants', auth, role('employer'), h(async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, employer: req.user.id });
  if (!job) return res.status(404).json({ msg: 'Not found' });
  res.json(await Application.find({ job: job._id }).populate('worker', 'name phone address'));
}));

app.post('/api/applications/:jobId', auth, role('worker'), h(async (req, res) => {
  try { res.json(await Application.create({ job: req.params.jobId, worker: req.user.id })); }
  catch { res.status(400).json({ msg: 'Already applied' }); }
}));

app.get('/api/applications/mine', auth, role('worker'), h(async (req, res) =>
  res.json(await Application.find({ worker: req.user.id }).sort('-createdAt')
    .populate({ path: 'job', populate: { path: 'employer', select: 'name phone' } }))));

app.patch('/api/applications/:id', auth, role('employer'), h(async (req, res) => {
  const a = await Application.findById(req.params.id).populate('job');
  if (!a || String(a.job.employer) !== req.user.id) return res.status(404).json({ msg: 'Not found' });
  if (!['accepted', 'rejected'].includes(req.body.status)) return res.status(400).json({ msg: 'Bad status' });
  a.status = req.body.status; await a.save(); res.json(a);
}));

// ---------------- FRONTEND (served as one page) ----------------
const HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Daily Work</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
<style>
body{font-family:system-ui,"Noto Sans Telugu","Noto Sans Devanagari",sans-serif;margin:0;background:#f4f6f8;color:#111}
#root{max-width:760px;margin:0 auto;padding:14px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px}
h2,h3{margin:8px 0}
nav{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 14px}
nav a{color:#1d4ed8;text-decoration:none;font-weight:600}
input,select,textarea{display:block;width:100%;box-sizing:border-box;padding:10px;margin:7px 0;font-size:16px;border:1px solid #bbb;border-radius:8px;background:#fff}
.btn{padding:10px 16px;font-size:16px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;cursor:pointer;margin:6px 6px 6px 0}
.btn.alt{background:#fff;color:#1d4ed8;border:1px solid #1d4ed8}
.btn.red{background:#b91c1c}.btn.green{background:#15803d}
.card{background:#fff;border:1px solid #d5d9de;border-radius:10px;padding:12px;margin:10px 0}
.card p{margin:5px 0}
#map{height:340px;border-radius:10px;border:1px solid #bbb;margin:10px 0}
.msg{color:#b91c1c;min-height:1.2em}.hint{color:#555;font-size:14px;margin:4px 0}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1;min-width:140px}
a.dir{display:inline-block;text-decoration:none}
</style></head>
<body><div id="root"><div id="head"></div><div id="app"></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
/*APP_START*/
var T = {
en:{appName:'Daily Work',jobs:'Jobs',nearby:'Jobs near me',login:'Login',register:'Register',logout:'Logout',name:'Name',phone:'Phone number',password:'Password',role:'I am a',worker:'Worker',employer:'Employer',address:'Address / landmark',wage:'Daily wage (Rs)',perDay:'per day',postJob:'Post a job',apply:'Apply',applied:'Applied',noJobs:'No jobs within this distance',title:'Job title',description:'Description',submit:'Submit',myApplications:'My applications',myJobs:'My jobs',applicants:'Applicants',category:'Category',status:'Status',pending:'Pending',accepted:'Accepted',rejected:'Rejected',all:'All',construction:'Construction',farming:'Farming',driver:'Driver',cooking:'Cooking',cleaning:'Cleaning',other:'Other',distance:'Distance',km:'km',radius:'Radius',useMyLocation:'Use my location',locDenied:'Location blocked. Tap on the map to set your location.',locating:'Finding your location...',locationSet:'Location set',viewMap:'Show on map',directions:'Get directions',call:'Call',owner:'Owner',you:'You (your location)',tapMap:'Tip: you can also tap on the map to set your location.',pickOnMap:'Tap on the map (or drag the pin) to choose the work location.',needLocation:'Please choose the job location on the map',loginToApply:'Login as worker to apply',accept:'Accept',reject:'Reject',noApplicants:'No applications yet',noData:'Nothing here yet',jobLocation:'Job location'},
te:{appName:'రోజువారీ పని',jobs:'పనులు',nearby:'దగ్గరలోని పనులు',login:'లాగిన్',register:'నమోదు',logout:'లాగౌట్',name:'పేరు',phone:'ఫోన్ నంబర్',password:'పాస్‌వర్డ్',role:'నేను',worker:'కార్మికుడు',employer:'యజమాని',address:'చిరునామా / గుర్తు',wage:'రోజు కూలీ (రూ)',perDay:'రోజుకు',postJob:'పని పోస్ట్ చేయండి',apply:'దరఖాస్తు చేయండి',applied:'దరఖాస్తు చేశారు',noJobs:'ఈ దూరంలో పనులు లేవు',title:'పని శీర్షిక',description:'వివరణ',submit:'సమర్పించండి',myApplications:'నా దరఖాస్తులు',myJobs:'నా పనులు',applicants:'దరఖాస్తుదారులు',category:'వర్గం',status:'స్థితి',pending:'పెండింగ్',accepted:'అంగీకరించారు',rejected:'తిరస్కరించారు',all:'అన్నీ',construction:'నిర్మాణం',farming:'వ్యవసాయం',driver:'డ్రైవర్',cooking:'వంట',cleaning:'శుభ్రపరచడం',other:'ఇతర',distance:'దూరం',km:'కి.మీ',radius:'పరిధి',useMyLocation:'నా లొకేషన్ ఉపయోగించండి',locDenied:'లొకేషన్ అనుమతి లేదు. మ్యాప్‌పై నొక్కి మీ లొకేషన్ సెట్ చేయండి.',locating:'మీ లొకేషన్ కనుగొంటున్నాం...',locationSet:'లొకేషన్ సెట్ అయింది',viewMap:'మ్యాప్‌లో చూడండి',directions:'దారి చూపించు',call:'కాల్',owner:'యజమాని',you:'మీరు (మీ లొకేషన్)',tapMap:'సూచన: మ్యాప్‌పై నొక్కి కూడా మీ లొకేషన్ సెట్ చేయవచ్చు.',pickOnMap:'పని ఉన్న చోటును మ్యాప్‌పై నొక్కండి (లేదా పిన్‌ను లాగండి).',needLocation:'దయచేసి మ్యాప్‌లో పని లొకేషన్ ఎంచుకోండి',loginToApply:'దరఖాస్తు చేయడానికి కార్మికుడిగా లాగిన్ అవ్వండి',accept:'అంగీకరించు',reject:'తిరస్కరించు',noApplicants:'ఇంకా దరఖాస్తులు లేవు',noData:'ఇక్కడ ఏమీ లేదు',jobLocation:'పని లొకేషన్'},
hi:{appName:'दैनिक काम',jobs:'काम',nearby:'मेरे आस-पास के काम',login:'लॉगिन',register:'रजिस्टर',logout:'लॉगआउट',name:'नाम',phone:'फ़ोन नंबर',password:'पासवर्ड',role:'मैं हूँ',worker:'मज़दूर',employer:'नियोक्ता',address:'पता / निशानी',wage:'दैनिक मज़दूरी (रु)',perDay:'प्रतिदिन',postJob:'काम पोस्ट करें',apply:'आवेदन करें',applied:'आवेदन किया',noJobs:'इस दूरी में कोई काम नहीं',title:'काम का शीर्षक',description:'विवरण',submit:'जमा करें',myApplications:'मेरे आवेदन',myJobs:'मेरे काम',applicants:'आवेदक',category:'श्रेणी',status:'स्थिति',pending:'लंबित',accepted:'स्वीकृत',rejected:'अस्वीकृत',all:'सभी',construction:'निर्माण',farming:'खेती',driver:'ड्राइवर',cooking:'खाना बनाना',cleaning:'सफ़ाई',other:'अन्य',distance:'दूरी',km:'कि.मी.',radius:'दायरा',useMyLocation:'मेरी लोकेशन इस्तेमाल करें',locDenied:'लोकेशन बंद है। नक्शे पर टैप करके अपनी लोकेशन चुनें।',locating:'आपकी लोकेशन खोज रहे हैं...',locationSet:'लोकेशन सेट हो गई',viewMap:'नक्शे पर देखें',directions:'रास्ता दिखाएँ',call:'कॉल',owner:'मालिक',you:'आप (आपकी लोकेशन)',tapMap:'सुझाव: नक्शे पर टैप करके भी अपनी लोकेशन चुन सकते हैं।',pickOnMap:'काम की जगह चुनने के लिए नक्शे पर टैप करें (या पिन खींचें)।',needLocation:'कृपया नक्शे पर काम की जगह चुनें',loginToApply:'आवेदन के लिए मज़दूर के रूप में लॉगिन करें',accept:'स्वीकार करें',reject:'अस्वीकार करें',noApplicants:'अभी कोई आवेदन नहीं',noData:'यहाँ कुछ नहीं है',jobLocation:'काम की जगह'}
};
var CATS = ['construction','farming','driver','cooking','cleaning','other'];
var lang = localStorage.getItem('lang') || 'te';
var user = JSON.parse(localStorage.getItem('user') || 'null');
var view = 'jobs', map = null, layer = null, markers = {}, me = null, radius = 10, cat = '', pick = null, pickMarker = null;
var $ = function (id) { return document.getElementById(id); };
var app = $('app');
function t(k) { return (T[lang] && T[lang][k]) || T.en[k] || k; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function api(path, method, body) {
  return fetch('/api' + path, { method: method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.msg || 'Error'); return d; }); });
}
function msg(s) { var e = $('msg'); if (e) e.textContent = s || ''; }
function opts(list, sel, label) { return list.map(function (x) { return '<option value="' + x + '"' + (String(x) === String(sel) ? ' selected' : '') + '>' + label(x) + '</option>'; }).join(''); }
function dirUrl(j) { return 'https://www.google.com/maps/dir/?api=1&destination=' + j.geo.coordinates[1] + ',' + j.geo.coordinates[0] + '&travelmode=driving'; }
function emoji(e) { return L.divIcon({ html: '<div style="font-size:30px;line-height:30px">' + e + '</div>', className: '', iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -26] }); }
function newMap(id, center, zoom) {
  if (map) { map.remove(); map = null; }
  map = L.map(id).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  setTimeout(function () { if (map) map.invalidateSize(); }, 200);
  return map;
}

// ---------- navigation ----------
function go(v) { view = v; render(); }
function render() {
  if (map) { map.remove(); map = null; }
  markers = {}; pickMarker = null;
  var link = function (v, label) { return '<a href="#" data-v="' + v + '">' + label + '</a>'; };
  var n = '<div class="top"><h2>🛠️ ' + t('appName') + '</h2><select id="lang" style="width:auto">' +
    '<option value="te">తెలుగు</option><option value="en">English</option><option value="hi">हिन्दी</option></select></div><nav>';
  n += link('jobs', t('jobs'));
  if (!user) n += link('login', t('login')) + link('register', t('register'));
  if (user && user.role === 'employer') n += link('post', t('postJob')) + link('myjobs', t('myJobs'));
  if (user && user.role === 'worker') n += link('myapps', t('myApplications'));
  if (user) n += '<a href="#" id="out">' + t('logout') + ' (' + esc(user.name) + ')</a>';
  $('head').innerHTML = n + '</nav>';
  $('lang').value = lang;
  $('lang').onchange = function () { lang = this.value; localStorage.setItem('lang', lang); render(); };
  Array.prototype.forEach.call(document.querySelectorAll('[data-v]'), function (a) { a.onclick = function (e) { e.preventDefault(); go(a.getAttribute('data-v')); }; });
  if ($('out')) $('out').onclick = function (e) { e.preventDefault(); localStorage.clear(); user = null; go('jobs'); };
  ({ jobs: viewJobs, login: function () { viewAuth('login'); }, register: function () { viewAuth('register'); }, post: viewPost, myjobs: viewMyJobs, myapps: viewMyApps })[view]();
}

// ---------- JOBS NEAR ME (map) ----------
function viewJobs() {
  app.innerHTML = '<h3>📍 ' + t('nearby') + '</h3>' +
    '<button class="btn" id="loc">📍 ' + t('useMyLocation') + '</button>' +
    '<div class="row"><select id="rad">' + opts([5, 10, 20, 30], radius, function (r) { return t('radius') + ': ' + r + ' ' + t('km'); }) + '</select>' +
    '<select id="cat"><option value="">' + t('category') + ': ' + t('all') + '</option>' + opts(CATS, cat, t) + '</select></div>' +
    '<p class="msg" id="msg"></p><p class="hint">' + t('tapMap') + '</p><div id="map"></div><div id="list"></div>';
  newMap('map', me ? [me.lat, me.lng] : [17.385, 78.4867], me ? 12 : 6);
  layer = L.layerGroup().addTo(map);
  map.on('click', function (e) { me = { lat: e.latlng.lat, lng: e.latlng.lng }; loadJobs(); });
  $('loc').onclick = locate;
  $('rad').onchange = function () { radius = +this.value; loadJobs(); };
  $('cat').onchange = function () { cat = this.value; loadJobs(); };
  $('list').onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    if (act === 'map' && markers[id]) { map.setView(markers[id].getLatLng(), 15); markers[id].openPopup(); $('map').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (act === 'apply') api('/applications/' + id, 'POST').then(function () { b.outerHTML = '<b>✓ ' + t('applied') + '</b>'; }).catch(function (er) { msg(er.message); });
  };
  if (me) loadJobs(); else locate();
}
function locate() {
  msg(t('locating'));
  if (!navigator.geolocation) { msg(t('locDenied')); return; }
  navigator.geolocation.getCurrentPosition(function (p) {
    me = { lat: p.coords.latitude, lng: p.coords.longitude }; msg(''); loadJobs();
  }, function () { msg(t('locDenied')); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}
function loadJobs() {
  if (!me || !map) return;
  msg('');
  api('/jobs/nearby?lat=' + me.lat + '&lng=' + me.lng + '&radius=' + radius + '&category=' + encodeURIComponent(cat))
    .then(function (jobs) { drawMap(jobs); drawList(jobs); })
    .catch(function (e) { msg(e.message); });
}
function drawMap(jobs) {
  layer.clearLayers(); markers = {};
  L.marker([me.lat, me.lng], { icon: emoji('🧍') }).addTo(layer).bindPopup(t('you'));
  var circle = L.circle([me.lat, me.lng], { radius: radius * 1000, color: '#1d4ed8', weight: 1, fillOpacity: 0.06 }).addTo(layer);
  jobs.forEach(function (j) {
    var ll = [j.geo.coordinates[1], j.geo.coordinates[0]];
    markers[j._id] = L.marker(ll, { icon: emoji('🏗️') }).addTo(layer).bindPopup(
      '<b>' + esc(j.title) + '</b><br>Rs ' + j.wage + ' ' + t('perDay') + '<br>' + j.distanceKm + ' ' + t('km') +
      '<br><a target="_blank" rel="noopener" href="' + dirUrl(j) + '">' + t('directions') + '</a>');
  });
  map.fitBounds(circle.getBounds());
}
function drawList(jobs) {
  if (!jobs.length) { $('list').innerHTML = '<p>' + t('noJobs') + '</p>'; return; }
  $('list').innerHTML = jobs.map(function (j) {
    var act = !user ? '<span class="hint">' + t('loginToApply') + '</span>'
      : user.role === 'worker' ? '<button class="btn" data-act="apply" data-id="' + j._id + '">' + t('apply') + '</button>' : '';
    return '<div class="card"><h3>' + esc(j.title) + '</h3><p>' + esc(j.description) + '</p>' +
      '<p>💰 Rs ' + j.wage + ' ' + t('perDay') + ' · ' + t(j.category || 'other') + '</p>' +
      '<p>📏 ' + t('distance') + ': <b>' + j.distanceKm + ' ' + t('km') + '</b></p>' +
      '<p>🏠 ' + esc(j.address) + '</p>' +
      '<p>👤 ' + t('owner') + ': ' + esc(j.employer && j.employer.name) + ' · <a href="tel:' + esc(j.employer && j.employer.phone) + '">📞 ' + esc(j.employer && j.employer.phone) + '</a></p>' +
      '<button class="btn alt" data-act="map" data-id="' + j._id + '">🗺️ ' + t('viewMap') + '</button>' +
      '<a class="btn dir" target="_blank" rel="noopener" href="' + dirUrl(j) + '">🧭 ' + t('directions') + '</a> ' + act + '</div>';
  }).join('');
}

// ---------- LOGIN / REGISTER ----------
function viewAuth(mode) {
  var reg = mode === 'register';
  app.innerHTML = (reg ? '<input id="name" placeholder="' + t('name') + '">' : '') +
    '<input id="phone" type="tel" placeholder="' + t('phone') + '">' +
    '<input id="password" type="password" placeholder="' + t('password') + '">' +
    (reg ? '<input id="address" placeholder="' + t('address') + '"><select id="role"><option value="worker">' + t('worker') + '</option><option value="employer">' + t('employer') + '</option></select>' : '') +
    '<p class="msg" id="msg"></p><button class="btn" id="go">' + t(mode) + '</button>';
  $('go').onclick = function () {
    var body = { phone: $('phone').value.trim(), password: $('password').value };
    if (reg) { body.name = $('name').value.trim(); body.address = $('address').value; body.role = $('role').value; }
    api('/auth/' + mode, 'POST', body).then(function (d) {
      localStorage.setItem('token', d.token); localStorage.setItem('user', JSON.stringify(d.user)); user = d.user;
      go(user.role === 'employer' ? 'post' : 'jobs');
    }).catch(function (e) { msg(e.message); });
  };
}

// ---------- POST JOB (employer picks location on map) ----------
function viewPost() {
  pick = null;
  app.innerHTML = '<h3>' + t('postJob') + '</h3><input id="title" placeholder="' + t('title') + '"><textarea id="desc" rows="3" placeholder="' + t('description') + '"></textarea>' +
    '<select id="cat">' + opts(CATS, 'construction', t) + '</select><input id="addr" placeholder="' + t('address') + '">' +
    '<input id="wage" type="number" placeholder="' + t('wage') + '">' +
    '<p class="hint">' + t('pickOnMap') + '</p><button class="btn alt" id="loc">📍 ' + t('useMyLocation') + '</button> <b id="ok"></b>' +
    '<div id="map"></div><p class="msg" id="msg"></p><button class="btn" id="go">' + t('submit') + '</button>';
  newMap('map', [17.385, 78.4867], 6);
  function show() { $('ok').textContent = pick ? '✓ ' + t('locationSet') + ' (' + pick.lat.toFixed(4) + ', ' + pick.lng.toFixed(4) + ')' : ''; }
  function setPick(lat, lng, zoom) {
    pick = { lat: lat, lng: lng };
    if (pickMarker) pickMarker.setLatLng([lat, lng]);
    else {
      pickMarker = L.marker([lat, lng], { draggable: true, icon: emoji('📍') }).addTo(map);
      pickMarker.on('dragend', function () { var p = pickMarker.getLatLng(); pick = { lat: p.lat, lng: p.lng }; show(); });
    }
    if (zoom) map.setView([lat, lng], zoom);
    show();
  }
  map.on('click', function (e) { setPick(e.latlng.lat, e.latlng.lng); });
  $('loc').onclick = function () {
    if (!navigator.geolocation) { msg(t('locDenied')); return; }
    msg(t('locating'));
    navigator.geolocation.getCurrentPosition(function (p) { msg(''); setPick(p.coords.latitude, p.coords.longitude, 16); },
      function () { msg(t('locDenied')); }, { enableHighAccuracy: true, timeout: 15000 });
  };
  $('go').onclick = function () {
    if (!pick) { msg(t('needLocation')); return; }
    api('/jobs', 'POST', { title: $('title').value.trim(), description: $('desc').value, category: $('cat').value,
      address: $('addr').value, wage: $('wage').value, lat: pick.lat, lng: pick.lng })
      .then(function () { go('myjobs'); }).catch(function (e) { msg(e.message); });
  };
}

// ---------- EMPLOYER: MY JOBS + APPLICANTS ----------
function viewMyJobs() {
  app.innerHTML = '<h3>' + t('myJobs') + '</h3><p class="msg" id="msg"></p><div id="list"></div>';
  api('/jobs/mine').then(function (jobs) {
    $('list').innerHTML = jobs.length ? jobs.map(function (j) {
      return '<div class="card"><b>' + esc(j.title) + '</b> · Rs ' + j.wage + '<p>🏠 ' + esc(j.address) + '</p>' +
        '<button class="btn alt" data-id="' + j._id + '">' + t('applicants') + '</button><div id="a' + j._id + '"></div></div>';
    }).join('') : '<p>' + t('noData') + '</p>';
  }).catch(function (e) { msg(e.message); });
  function loadApplicants(id) {
    api('/jobs/' + id + '/applicants').then(function (list) {
      $('a' + id).innerHTML = list.length ? list.map(function (a) {
        return '<p>👷 ' + esc(a.worker.name) + ' · <a href="tel:' + esc(a.worker.phone) + '">📞 ' + esc(a.worker.phone) + '</a> · <b>' + t(a.status) + '</b><br>' +
          '<button class="btn green" data-app="' + a._id + '" data-st="accepted" data-job="' + id + '">' + t('accept') + '</button>' +
          '<button class="btn red" data-app="' + a._id + '" data-st="rejected" data-job="' + id + '">' + t('reject') + '</button></p>';
      }).join('') : '<p>' + t('noApplicants') + '</p>';
    }).catch(function (e) { msg(e.message); });
  }
  $('list').onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.getAttribute('data-app')) api('/applications/' + b.getAttribute('data-app'), 'PATCH', { status: b.getAttribute('data-st') }).then(function () { loadApplicants(b.getAttribute('data-job')); });
    else loadApplicants(b.getAttribute('data-id'));
  };
}

// ---------- WORKER: MY APPLICATIONS (with owner location link) ----------
function viewMyApps() {
  app.innerHTML = '<h3>' + t('myApplications') + '</h3><p class="msg" id="msg"></p><div id="list"></div>';
  api('/applications/mine').then(function (list) {
    $('list').innerHTML = list.length ? list.filter(function (a) { return a.job; }).map(function (a) {
      var j = a.job;
      return '<div class="card"><b>' + esc(j.title) + '</b> · Rs ' + j.wage + ' ' + t('perDay') + '<p>' + t('status') + ': <b>' + t(a.status) + '</b></p>' +
        '<p>🏠 ' + esc(j.address) + '</p><p>👤 ' + esc(j.employer && j.employer.name) + ' · <a href="tel:' + esc(j.employer && j.employer.phone) + '">📞 ' + esc(j.employer && j.employer.phone) + '</a></p>' +
        '<a class="btn dir" target="_blank" rel="noopener" href="' + dirUrl(j) + '">🧭 ' + t('directions') + ' (' + t('jobLocation') + ')</a></div>';
    }).join('') : '<p>' + t('noData') + '</p>';
  }).catch(function (e) { msg(e.message); });
}

render();
/*APP_END*/
</script></body></html>`;

app.get('/', (req, res) => res.type('html').send(HTML));
app.get('*', (req, res) => res.redirect('/'));

// ---------------- START ----------------
app.listen(PORT, () => console.log('Server running on port ' + PORT));
mongoose.connect(MONGO)
  .then(async () => { await Job.init(); console.log('MongoDB connected'); })
  .catch(e => console.error('DB error', e.message));
