/* =========================================================================
   QUEST FIT — client
   Talks to the Express + Postgres backend over /api/*. Login sessions are
   per-tab tokens stored in sessionStorage (not cookies), so each browser
   tab can be logged into a different account. Matching requires mutual
   consent: liking someone sends a pending request, and a private chat only
   opens once the other person accepts it. Chat and match notifications
   update live over a WebSocket.
   ========================================================================= */

const SPORTS = [
  {id:'basketball', label:'Basketball', emoji:'🏀'},
  {id:'football', label:'Football (Soccer)', emoji:'⚽'},
  {id:'american-football', label:'American Football', emoji:'🏈'},
  {id:'tennis', label:'Tennis', emoji:'🎾'},
  {id:'running', label:'Running', emoji:'🏃'},
  {id:'cycling', label:'Cycling', emoji:'🚴'},
  {id:'swimming', label:'Swimming', emoji:'🏊'},
  {id:'volleyball', label:'Volleyball', emoji:'🏐'},
  {id:'yoga', label:'Yoga', emoji:'🧘'},
  {id:'golf', label:'Golf', emoji:'⛳'},
  {id:'boxing', label:'Boxing', emoji:'🥊'},
  {id:'climbing', label:'Climbing', emoji:'🧗'},
  {id:'baseball', label:'Baseball', emoji:'⚾'},
  {id:'hiking', label:'Hiking', emoji:'🥾'},
  {id:'badminton', label:'Badminton', emoji:'🏸'},
];
const sportById = id => SPORTS.find(s=>s.id===id);

const AVATAR_EMOJIS = ['🏅','🔥','⚡','🌟','🚀','🏆','💪','🎯','🌈','🦁','🐺','🐻','🦅','🐢','🌵','🍀'];
const ACCENT_COLORS = ['#C6FF3D','#FF9F1C','#FF4D6D','#4DA3FF','#B98CFF','#4DFFD2'];
const TITLES = [
  '', 'Weekend Warrior', 'Early Riser', 'Gym Rat', 'Trail Blazer', 'Team Captain',
  'Cardio Junkie', 'Zen Master', 'Adrenaline Seeker', 'Rookie', 'MVP', 'Iron Will', 'Comeback Kid'
];
const MAX_BIO_LENGTH = 200;
const MAX_POST_CAPTION_LENGTH = 200;

let state = {
  screen: 'loading',      // 'loading' | 'login' | 'signup' | 'app'
  tab: 'discover',
  session: null,           // {name, age, gender, sports}
  authError: '',
  signupForm: {name:'', email:'', password:'', confirm:'', age:'', gender:'', sports:[]},
  loginForm: {email:'', password:''},
  discoverQueue: null,
  discoverLoading: false,
  activeCard: null,
  cardLeaving: null,
  matchModal: null,
  searchFilters: {sport:'', minAge:'', maxAge:'', name:''},
  searchResults: null,
  searchLoading: false,
  myMatches: {incoming:[], sent:[], accepted:[]},
  matchesLoading: true,
  activeChatWith: null,
  chatMessages: [],
  chatLoading: false,
  toast: null,
  profileModalOpen: false,
  profileForm: null,       // {bio, avatarEmoji, avatarColor, title, photoDataUrl}
  profileSaving: false,
  profileError: '',
  viewingProfile: null,     // another user's full profile object, when open
  viewingProfilePosts: [],
  viewingProfilePostsLoading: false,
  myPosts: [],
  myPostsLoading: true,
  addPostModalOpen: false,
  addPostForm: null,        // {imageDataUrl, caption}
  addPostSaving: false,
  addPostError: '',
};

function setState(patch){ state = {...state, ...patch}; render(); }
function showToast(msg){ setState({toast: msg}); setTimeout(()=>{ if(state.toast===msg) setState({toast:null}); }, 2600); }

// ---------- live chat (WebSocket) ----------
let liveSocket = null;

function connectLive(){
  if(liveSocket){ try{ liveSocket.close(); }catch(e){} liveSocket = null; }
  const token = getToken();
  if(!token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.onmessage = (event) => {
    let payload;
    try{ payload = JSON.parse(event.data); }catch(e){ return; }
    if(payload.type === 'message') handleIncomingMessage(payload.withName, payload.message);
    else if(payload.type === 'match_request') handleIncomingMatchRequest(payload.fromName);
    else if(payload.type === 'match_accepted') handleMatchAccepted(payload.withName);
  };
  socket.onclose = () => {
    if(liveSocket === socket) liveSocket = null;
    // Keep trying to reconnect as long as we're still logged in (covers
    // brief network hiccups or a server restart).
    if(getToken()) setTimeout(connectLive, 2000);
  };
  socket.onerror = () => { try{ socket.close(); }catch(e){} };

  liveSocket = socket;
}
function disconnectLive(){
  if(liveSocket){ try{ liveSocket.close(); }catch(e){} liveSocket = null; }
}
function handleIncomingMessage(withName, message){
  if(state.tab === 'matches' && state.activeChatWith === withName){
    setState({chatMessages: [...state.chatMessages, message]});
  } else {
    showToast('New message from '+withName);
  }
  refreshMyMatches();
}
function handleIncomingMatchRequest(fromName){
  showToast(fromName+' wants to match with you — check Matches to respond.');
  refreshMyMatches();
}
function handleMatchAccepted(withName){
  showToast(withName+' accepted your match request! You can chat now.');
  refreshMyMatches();
}

// ---------- API helper ----------
// The auth token is stored in sessionStorage, which is scoped to a single
// browser TAB (unlike cookies or localStorage, which are shared across
// every tab for the same site). That's what lets you log in as a
// different account in each tab of the same browser.
const TOKEN_KEY = 'questfit_token';
function getToken(){ return sessionStorage.getItem(TOKEN_KEY); }
function setToken(token){ sessionStorage.setItem(TOKEN_KEY, token); }
function clearToken(){ sessionStorage.removeItem(TOKEN_KEY); }

async function api(path, opts={}){
  try{
    const headers = {'Content-Type':'application/json'};
    const token = getToken();
    if(token) headers['Authorization'] = 'Bearer '+token;
    const res = await fetch('/api'+path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){ return {error: data.error || 'Something went wrong.'}; }
    return data;
  }catch(e){
    return {error: 'Could not reach the server. Is it running?'};
  }
}

// ---------- validation (mirrors server rules, for instant feedback) ----------
function validateEmail(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function passwordChecks(pw){
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    number: /[0-9]/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}
function passwordValid(pw){
  const c = passwordChecks(pw);
  return c.length && c.upper && c.lower && c.number && c.special;
}

// ---------- auth ----------
async function checkSession(){
  if(!getToken()){ return setState({screen:'login'}); }
  const data = await api('/me');
  if(data.user){
    setState({screen:'app', session:data.user, tab:'discover'});
    connectLive();
  } else {
    clearToken();
    setState({screen:'login'});
  }
}

async function handleSignup(){
  const f = state.signupForm;
  const name = f.name.trim();
  const email = f.email.trim();

  if(!name){ return setState({authError:'Enter a name.'}); }
  if(!validateEmail(email)){ return setState({authError:'Enter a valid email address.'}); }
  if(!passwordValid(f.password)){ return setState({authError:'Password does not meet the requirements below.'}); }
  if(f.password !== f.confirm){ return setState({authError:'Passwords do not match.'}); }
  if(!f.age || Number(f.age) < 13 || Number(f.age) > 100){ return setState({authError:'Enter a valid age (13–100).'}); }
  if(!f.gender){ return setState({authError:'Select a gender.'}); }
  if(f.sports.length === 0){ return setState({authError:"Pick at least one sport you're interested in."}); }

  setState({authError:'…creating your account'});
  const data = await api('/signup', {method:'POST', body:{
    name, email, password:f.password, age:Number(f.age), gender:f.gender, sports:f.sports
  }});
  if(data.error) return setState({authError:data.error});
  setToken(data.token);

  setState({
    screen:'app', tab:'discover', session:data.user, authError:'',
    signupForm:{name:'', email:'', password:'', confirm:'', age:'', gender:'', sports:[]},
    discoverQueue:null,
  });
  connectLive();
  showToast('Welcome to Quest Fit, '+data.user.name+'!');
}

async function handleLogin(){
  const f = state.loginForm;
  if(!validateEmail(f.email) || !f.password){ return setState({authError:'Enter your email and password.'}); }
  setState({authError:'…signing in'});
  const data = await api('/login', {method:'POST', body:{email:f.email.trim(), password:f.password}});
  if(data.error) return setState({authError:data.error});
  setToken(data.token);
  setState({screen:'app', tab:'discover', session:data.user, authError:'', loginForm:{email:'',password:''}, discoverQueue:null});
  connectLive();
  showToast('Welcome back, '+data.user.name+'!');
}

async function handleLogout(){
  await api('/logout', {method:'POST'});
  clearToken();
  disconnectLive();
  setState({screen:'login', session:null, tab:'discover', discoverQueue:null, myMatches:{incoming:[], sent:[], accepted:[]}, activeChatWith:null, myPosts:[], myPostsLoading:true});
}

// ---------- profile customization ----------
function openProfileModal(){
  const self = state.session;
  setState({
    profileModalOpen: true,
    profileError: '',
    profileForm: {
      bio: self.bio || '',
      avatarEmoji: self.avatarEmoji || '🏅',
      avatarColor: self.avatarColor || '#C6FF3D',
      title: self.title || '',
      photoDataUrl: self.photoDataUrl || null,
    }
  });
}
function closeProfileModal(){
  setState({profileModalOpen:false, profileForm:null, profileError:''});
}

// Downscales and compresses a chosen photo client-side before it's sent to
// the server as base64 JSON - keeps uploads small and fast regardless of
// the original photo's resolution.
function handlePhotoFile(file){
  if(!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const size = 320;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // cover-crop to a square so avatars aren't stretched
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      setState({profileForm: {...state.profileForm, photoDataUrl: dataUrl}});
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function saveProfile(){
  const f = state.profileForm;
  if(f.bio.length > MAX_BIO_LENGTH){
    return setState({profileError: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.`});
  }
  setState({profileSaving:true, profileError:''});
  const body = {
    bio: f.bio,
    avatarEmoji: f.avatarEmoji,
    avatarColor: f.avatarColor,
    title: f.title,
  };
  if(f.photoDataUrl === null) body.removePhoto = true;
  else body.photoDataUrl = f.photoDataUrl;

  const data = await api('/profile', {method:'POST', body});
  setState({profileSaving:false});
  if(data.error) return setState({profileError: data.error});

  setState({session: data.user, profileModalOpen:false, profileForm:null});
  showToast('Profile updated!');
}

function openProfileView(user){
  setState({viewingProfile: user, viewingProfilePosts: [], viewingProfilePostsLoading: true});
  loadPostsFor(user.name, (posts) => {
    // Only apply if we're still looking at the same profile (avoids a race
    // if the person clicks a different profile before this finishes).
    if(state.viewingProfile && state.viewingProfile.name === user.name){
      setState({viewingProfilePosts: posts, viewingProfilePostsLoading: false});
    }
  });
}
function closeProfileView(){
  setState({viewingProfile: null, viewingProfilePosts: []});
}
async function matchFromProfileView(otherName){
  const data = await api('/swipe', {method:'POST', body:{targetName:otherName, action:'like'}});
  if(data.error) return showToast(data.error);
  if(data.status === 'accepted'){
    showToast("It's a match with "+otherName+"! Check your Matches tab.");
  } else {
    showToast('Match request sent to '+otherName+' — waiting for them to accept.');
  }
  closeProfileView();
  refreshMyMatches();
}

// ---------- photo posts ----------
async function loadPostsFor(name, onDone){
  const data = await api('/posts/'+encodeURIComponent(name));
  onDone(data.posts || []);
}
async function loadMyPosts(){
  setState({myPostsLoading:true});
  const data = await api('/posts/'+encodeURIComponent(state.session.name));
  setState({myPosts: data.posts || [], myPostsLoading:false});
}

function openAddPostModal(){
  setState({addPostModalOpen:true, addPostForm:{imageDataUrl:null, caption:''}, addPostError:''});
}
function closeAddPostModal(){
  setState({addPostModalOpen:false, addPostForm:null, addPostError:''});
}

// Same resize/compress approach as profile photos, but preserves the
// original aspect ratio (contain, not a square crop) since posts are
// viewed larger than an avatar.
function handlePostPhotoFile(file){
  if(!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 900;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      setState({addPostForm: {...state.addPostForm, imageDataUrl: dataUrl}});
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function submitPost(){
  const f = state.addPostForm;
  if(!f.imageDataUrl) return setState({addPostError:'Choose a photo to post.'});
  if(f.caption.length > MAX_POST_CAPTION_LENGTH){
    return setState({addPostError:`Caption must be ${MAX_POST_CAPTION_LENGTH} characters or fewer.`});
  }
  setState({addPostSaving:true, addPostError:''});
  const data = await api('/posts', {method:'POST', body:{imageDataUrl:f.imageDataUrl, caption:f.caption}});
  setState({addPostSaving:false});
  if(data.error) return setState({addPostError:data.error});

  setState({myPosts:[data.post, ...state.myPosts], addPostModalOpen:false, addPostForm:null});
  showToast('Posted!');
}

async function deletePost(postId){
  if(!confirm('Delete this post?')) return;
  const data = await api('/posts/'+postId, {method:'DELETE'});
  if(data.error) return showToast(data.error);
  setState({myPosts: state.myPosts.filter(p => p.id !== Number(postId))});
}

// ---------- discover ----------
async function loadDiscoverQueue(){
  setState({discoverLoading:true});
  const data = await api('/discover');
  if(data.error){ showToast(data.error); return setState({discoverLoading:false, discoverQueue:[]}); }
  setState({discoverQueue:data.candidates, activeCard:data.candidates[0] || null, discoverLoading:false, cardLeaving:null});
}

async function swipe(action){
  const card = state.activeCard;
  if(!card || state.cardLeaving) return;
  setState({cardLeaving: action});

  setTimeout(async ()=>{
    const data = await api('/swipe', {method:'POST', body:{targetName:card.name, action: action==='match' ? 'like' : 'pass'}});
    const rest = state.discoverQueue.filter(u => u.name !== card.name);
    setState({discoverQueue: rest, activeCard: rest[0] || null, cardLeaving:null});
    if(!data.error && action === 'match'){
      if(data.status === 'accepted'){
        setState({matchModal: card});
      } else {
        showToast('Match request sent to '+card.name+' — waiting for them to accept.');
      }
      refreshMyMatches();
    }
  }, 260);
}

// ---------- search ----------
async function runSearch(){
  setState({searchLoading:true});
  const f = state.searchFilters;
  const params = new URLSearchParams();
  if(f.sport) params.set('sport', f.sport);
  if(f.minAge) params.set('minAge', f.minAge);
  if(f.maxAge) params.set('maxAge', f.maxAge);
  if(f.name) params.set('name', f.name);
  const data = await api('/search?'+params.toString());
  setState({searchResults: data.results || [], searchLoading:false});
}

async function matchFromSearch(otherName){
  const data = await api('/swipe', {method:'POST', body:{targetName:otherName, action:'like'}});
  if(data.error) return showToast(data.error);
  if(data.status === 'accepted'){
    showToast("It's a match with "+otherName+"! Check your Matches tab.");
  } else {
    showToast('Match request sent to '+otherName+' — waiting for them to accept.');
  }
  runSearch();
  refreshMyMatches();
}

// ---------- matches / chat ----------
async function loadMyMatches(){
  setState({matchesLoading:true});
  const data = await api('/matches');
  if(data.error){ return setState({matchesLoading:false}); }
  setState({
    myMatches: {
      incoming: data.incoming || [],
      sent: data.sent || [],
      accepted: data.accepted || [],
    },
    matchesLoading:false
  });
}

// Same as loadMyMatches, but doesn't toggle matchesLoading first - used to
// silently sync the Matches data in the background (e.g. right after you
// send/accept a request, or when a live event arrives) without flashing a
// "Loading matches…" placeholder over data that's already on screen.
async function refreshMyMatches(){
  const data = await api('/matches');
  if(data.error) return;
  setState({
    myMatches: {
      incoming: data.incoming || [],
      sent: data.sent || [],
      accepted: data.accepted || [],
    }
  });
}

async function acceptMatchRequest(matchId, otherName){
  const data = await api('/matches/'+matchId+'/accept', {method:'POST'});
  if(data.error) return showToast(data.error);
  showToast("It's a match with "+otherName+"!");
  refreshMyMatches();
}

async function declineMatchRequest(matchId){
  const data = await api('/matches/'+matchId+'/decline', {method:'POST'});
  if(data.error) return showToast(data.error);
  refreshMyMatches();
}

async function openChat(otherName){
  setState({activeChatWith: otherName, chatLoading:true});
  let data = await api('/chat/'+encodeURIComponent(otherName));
  if(data.error){
    // The database connection can be slow to wake up right after the
    // server starts (common on free-tier hosts) - retry once silently
    // before bothering the user with an error.
    await new Promise(r => setTimeout(r, 1200));
    data = await api('/chat/'+encodeURIComponent(otherName));
  }
  if(data.error){
    showToast("Couldn't load messages: "+data.error);
  }
  setState({chatMessages: data.messages || [], chatLoading:false});
}

async function sendMessage(text, inputEl){
  if(!text.trim() || !state.activeChatWith) return;
  const data = await api('/chat/'+encodeURIComponent(state.activeChatWith), {method:'POST', body:{text}});
  if(data.error){
    // Leave the typed text in place on failure so nothing is lost - the
    // person can just hit Send again once the connection is back.
    showToast("Message didn't send: "+data.error);
    return;
  }
  if(inputEl) inputEl.value = '';
  setState({chatMessages: [...state.chatMessages, data.message]});
}

// ---------- rendering ----------
function esc(s){ const d=document.createElement('div'); d.innerText = s==null?'':String(s); return d.innerHTML; }

function renderAuth(){
  if(state.screen === 'loading'){
    return `<div class="auth-wrap"><div style="color:var(--ink-dim);">Loading…</div></div>`;
  }
  if(state.screen === 'signup'){
    const f = state.signupForm;
    const pc = passwordChecks(f.password);
    return `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-hero">
          <div class="display">Join <span>Quest Fit</span></div>
          <p>Create a profile and get matched with people who play your sport.</p>
        </div>
        ${state.authError ? `<div class="error-box">${esc(state.authError)}</div>` : ''}
        <div class="field">
          <label>Unique display name</label>
          <input id="su-name" type="text" value="${esc(f.name)}" placeholder="e.g. JordanRuns" />
        </div>
        <div class="field">
          <label>Email</label>
          <input id="su-email" type="email" value="${esc(f.email)}" placeholder="you@example.com" />
        </div>
        <div class="field">
          <label>Password</label>
          ${passwordField('su-password', f.password, 'Create a password')}
          <div class="hint">
            <span class="${pc.length?'ok':'bad'}">8+ chars</span> ·
            <span class="${pc.upper?'ok':'bad'}">1 uppercase</span> ·
            <span class="${pc.lower?'ok':'bad'}">1 lowercase</span> ·
            <span class="${pc.number?'ok':'bad'}">1 number</span> ·
            <span class="${pc.special?'ok':'bad'}">1 symbol</span>
          </div>
        </div>
        <div class="field">
          <label>Confirm password</label>
          ${passwordField('su-confirm', f.confirm, 'Repeat password')}
        </div>
        <div class="field-row">
          <div class="field">
            <label>Age</label>
            <input id="su-age" type="number" min="13" max="100" value="${esc(f.age)}" placeholder="25" />
          </div>
          <div class="field">
            <label>Gender</label>
            <select id="su-gender">
              <option value="">Select…</option>
              ${['Female','Male','Non-binary','Prefer not to say'].map(g=>`<option value="${g}" ${f.gender===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label>Sports you're interested in</label>
          <div class="chip-grid">
            ${SPORTS.map(s=>`<div class="chip ${f.sports.includes(s.id)?'selected':''}" data-sport="${s.id}">${s.emoji} ${s.label}</div>`).join('')}
          </div>
        </div>
        <button class="btn btn-lime btn-block" id="su-submit" style="margin-top:8px;">Create account</button>
        <div class="switcher">Already have an account? <a id="go-login">Log in</a></div>
        <div class="note-box">Your account, matches and messages are now stored in a real database on this server — not shared with anyone else who runs their own copy of the app.</div>
      </div>
    </div>`;
  }

  const f = state.loginForm;
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-hero">
        <div class="display">Welcome to <span>Quest Fit</span></div>
        <p>Find people who love the same sport as you. Swipe, match, play.</p>
      </div>
      ${state.authError ? `<div class="error-box">${esc(state.authError)}</div>` : ''}
      <div class="field">
        <label>Email</label>
        <input id="li-email" type="email" value="${esc(f.email)}" placeholder="you@example.com" />
      </div>
      <div class="field">
        <label>Password</label>
        ${passwordField('li-password', f.password, 'Your password')}
      </div>
      <button class="btn btn-lime btn-block" id="li-submit" style="margin-top:8px;">Log in</button>
      <div class="switcher">New here? <a id="go-signup">Create an account</a></div>
    </div>
  </div>`;
}

function passwordField(id, value, placeholder){
  return `
  <div class="password-wrap">
    <input id="${id}" type="password" value="${esc(value)}" placeholder="${esc(placeholder)}" />
    <button type="button" class="pw-toggle" data-target="${id}">Show</button>
  </div>`;
}

// Renders a circular avatar: the user's photo if they've set one, otherwise
// their chosen emoji on their chosen color background.
function avatarHTML(user, size){
  const s = size || 40;
  if(user.photoDataUrl){
    return `<img src="${user.photoDataUrl}" class="avatar-img" style="width:${s}px;height:${s}px;" alt="${esc(user.name)}" />`;
  }
  const emoji = user.avatarEmoji || '🏅';
  const color = user.avatarColor || '#C6FF3D';
  return `<div class="avatar-emoji" style="width:${s}px;height:${s}px;font-size:${Math.round(s*0.52)}px;background:${color}22;border-color:${color}55;">${emoji}</div>`;
}
function titleBadgeHTML(user){
  if(!user.title) return '';
  return `<div class="title-badge">${esc(user.title)}</div>`;
}
function joinedLabel(user){
  if(!user.joinedAt) return '';
  const d = new Date(user.joinedAt);
  return d.toLocaleDateString([], {month:'long', year:'numeric'});
}

function sportTag(id, shared){
  const s = sportById(id);
  if(!s) return '';
  return `<div class="sport-tag ${shared?'shared':''}">${s.emoji} ${s.label}</div>`;
}

function renderDiscover(self){
  if(state.discoverLoading || state.discoverQueue === null){
    return `<div class="empty-state">Finding people near your sports…</div>`;
  }
  const card = state.activeCard;
  const remaining = state.discoverQueue.length;
  let body;
  if(!card){
    body = `<div class="empty-state">
      <div class="display">You're all caught up</div>
      No one new shares your sports right now — check back later, or try Search to browse everyone.
    </div>`;
  } else {
    const sharedSports = card.sports.filter(s=>self.sports.includes(s));
    const otherSports = card.sports.filter(s=>!self.sports.includes(s));
    body = `
    <div class="card-stage">
      <div class="player-card ${state.cardLeaving?'leaving-'+state.cardLeaving:''}">
        <div class="card-top">
          <div class="ribbon">${sportById(sharedSports[0]).emoji}</div>
          <div class="card-top-row">
            ${avatarHTML(card, 56)}
            <div>
              <div class="card-name display">${esc(card.name)}</div>
              <div class="card-meta">${card.age} · ${esc(card.gender)}</div>
            </div>
          </div>
          ${titleBadgeHTML(card)}
        </div>
        <div class="card-body">
          ${card.bio ? `<p class="card-bio">${esc(card.bio)}</p>` : ''}
          <div>
            <div class="stat-label">Plays in common</div>
            <div class="sport-tags">${sharedSports.map(s=>sportTag(s,true)).join('')}</div>
          </div>
          ${otherSports.length ? `<div>
            <div class="stat-label">Also into</div>
            <div class="sport-tags">${otherSports.map(s=>sportTag(s,false)).join('')}</div>
          </div>` : ''}
        </div>
      </div>
    </div>
    <div class="swipe-row">
      <button class="swipe-btn pass" id="btn-pass">✕ Pass</button>
      <button class="swipe-btn match" id="btn-match">🔥 Match</button>
    </div>`;
  }
  return `
  <div class="discover-wrap">
    <div class="scoreboard mono">
      <div class="num"><b>${remaining}</b> in queue</div>
      <div class="num">Matching on <b>${self.sports.length}</b> sport${self.sports.length===1?'':'s'}</div>
    </div>
    ${body}
  </div>`;
}

function renderSearch(){
  const f = state.searchFilters;
  const results = state.searchResults;
  return `
  <div>
    <div class="search-bar">
      <div class="field">
        <label>Sport</label>
        <select id="sf-sport">
          <option value="">Any sport</option>
          ${SPORTS.map(s=>`<option value="${s.id}" ${f.sport===s.id?'selected':''}>${s.emoji} ${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="max-width:110px;">
        <label>Min age</label>
        <input id="sf-minage" type="number" value="${esc(f.minAge)}" placeholder="18" />
      </div>
      <div class="field" style="max-width:110px;">
        <label>Max age</label>
        <input id="sf-maxage" type="number" value="${esc(f.maxAge)}" placeholder="99" />
      </div>
      <div class="field">
        <label>Name</label>
        <input id="sf-name" type="text" value="${esc(f.name)}" placeholder="Search by name" />
      </div>
      <div class="field" style="flex:0;align-self:flex-end;">
        <button class="btn btn-lime" id="sf-submit">Search</button>
      </div>
    </div>
    ${state.searchLoading ? `<div class="empty-state">Searching…</div>` :
      results === null ? `<div class="empty-state">Set your filters and hit Search to browse everyone on Quest Fit.</div>` :
      results.length === 0 ? `<div class="empty-state">No profiles match those filters.</div>` :
      `<div class="results-grid">${results.map(u=>`
        <div class="mini-card">
          <div class="mc-top-row mc-top-row-clickable" data-view-profile="${esc(u.name)}">
            ${avatarHTML(u, 44)}
            <div>
              <div class="mc-name display" style="font-size:16px;">${esc(u.name)}</div>
              <div class="mc-meta">${u.age} · ${esc(u.gender)}</div>
            </div>
          </div>
          ${titleBadgeHTML(u)}
          ${u.bio ? `<p class="mc-bio">${esc(u.bio)}</p>` : ''}
          <div class="sport-tags">${u.sports.map(s=>sportTag(s,false)).join('')}</div>
          <button class="btn btn-lime btn-sm" data-match="${esc(u.name)}">🔥 Match</button>
        </div>`).join('')}</div>`
    }
  </div>`;
}

function renderProfile(self){
  return `
  <div class="profile-page">
    <div class="profile-header">
      ${avatarHTML(self, 96)}
      <div class="profile-header-info">
        <div class="profile-name-row">
          <div class="display" style="font-size:24px;">${esc(self.name)}</div>
          <button class="btn btn-ghost btn-sm" id="profile-page-edit-btn">Edit profile</button>
        </div>
        <div class="card-meta">${self.age} · ${esc(self.gender)}</div>
        ${titleBadgeHTML(self)}
        <div class="profile-stats-row">
          <div class="profile-stat"><b>${state.myPosts.length}</b><span>post${state.myPosts.length===1?'':'s'}</span></div>
          <div class="profile-stat"><b>${self.sports.length}</b><span>sport${self.sports.length===1?'':'s'}</span></div>
          <div class="profile-stat"><b>${state.myMatches.accepted.length}</b><span>match${state.myMatches.accepted.length===1?'':'es'}</span></div>
          ${joinedLabel(self) ? `<div class="profile-stat"><b>${joinedLabel(self)}</b><span>joined</span></div>` : ''}
        </div>
      </div>
    </div>

    ${self.bio ? `<p class="profile-bio">${esc(self.bio)}</p>` : `<p class="profile-bio profile-bio-empty">No bio yet — add one from Edit profile.</p>`}

    <div class="stat-label" style="margin-top:22px;">Plays</div>
    <div class="sport-tags">${self.sports.map(s=>sportTag(s,false)).join('')}</div>

    <div class="posts-header">
      <div class="stat-label" style="margin:0;">Posts</div>
      <button class="btn btn-lime btn-sm" id="add-post-btn">+ Add post</button>
    </div>
    ${renderPostsGrid(state.myPosts, state.myPostsLoading, true)}
  </div>`;
}

function renderPostsGrid(posts, loading, ownPosts){
  if(loading) return `<div class="posts-loading">Loading posts…</div>`;
  if(posts.length === 0) return `<div class="posts-empty">${ownPosts ? "You haven't posted anything yet." : "No posts yet."}</div>`;
  return `<div class="posts-grid">${posts.map(p=>`
    <div class="post-tile" style="background-image:url('${p.imageDataUrl}')" data-post-id="${p.id}">
      ${p.caption ? `<div class="post-tile-caption">${esc(p.caption)}</div>` : ''}
      ${ownPosts ? `<button class="post-delete-btn" data-delete-post="${p.id}" title="Delete post">✕</button>` : ''}
    </div>`).join('')}</div>`;
}

function renderProfileViewModal(){
  const u = state.viewingProfile;
  if(!u) return '';
  return `
    <div class="modal-backdrop" id="profile-view-backdrop">
      <div class="modal-card profile-modal">
        <div style="text-align:center;">
          <div style="display:flex;justify-content:center;margin-bottom:14px;">${avatarHTML(u, 88)}</div>
          <div class="display" style="font-size:22px;">${esc(u.name)}</div>
          <div class="card-meta" style="margin-bottom:6px;">${u.age} · ${esc(u.gender)}</div>
          ${titleBadgeHTML(u)}
        </div>
        ${u.bio ? `<p class="profile-bio" style="margin-top:16px;">${esc(u.bio)}</p>` : ''}
        <div class="stat-label" style="margin-top:16px;">Plays</div>
        <div class="sport-tags">${u.sports.map(s=>sportTag(s,false)).join('')}</div>
        <div class="stat-label" style="margin-top:16px;">Posts</div>
        ${renderPostsGrid(state.viewingProfilePosts, state.viewingProfilePostsLoading, false)}
        <button class="btn btn-lime btn-block" id="profile-view-match-btn" style="margin-top:20px;">🔥 Match</button>
        <button class="btn btn-ghost btn-block" id="profile-view-close-btn" style="margin-top:10px;">Close</button>
      </div>
    </div>`;
}

function renderMatches(){
  const { incoming, sent, accepted } = state.myMatches;
  const nothingAtAll = incoming.length === 0 && sent.length === 0 && accepted.length === 0;
  const chatOther = accepted.find(m => m.other.name === state.activeChatWith)?.other
    || {name: state.activeChatWith, avatarEmoji:'🏅', avatarColor:'#C6FF3D', photoDataUrl:null};

  return `
  <div class="matches-layout">
    <div class="match-list">
      ${state.matchesLoading ? `<div style="padding:16px;color:var(--ink-dim);font-size:13px;">Loading matches…</div>` :
        nothingAtAll ? `<div style="padding:16px;color:var(--ink-dim);font-size:13px;">No matches yet — go match with someone in Discover.</div>` : `

        ${incoming.length ? `
        <div class="match-section-label">Requests for you</div>
        ${incoming.map(m=>`
        <div class="match-item request-item">
          <div class="mi-top-row">
            ${avatarHTML(m.other, 36)}
            <div>
              <div class="mi-name">${esc(m.other.name)}</div>
              <div class="mi-sub">${m.other.sports.map(s=>sportById(s).emoji).join(' ')}</div>
            </div>
          </div>
          <div class="request-actions">
            <button class="btn btn-lime btn-sm" data-accept="${m.matchId}" data-accept-name="${esc(m.other.name)}">Accept</button>
            <button class="btn btn-ghost btn-sm" data-decline="${m.matchId}">Decline</button>
          </div>
        </div>`).join('')}` : ''}

        ${sent.length ? `
        <div class="match-section-label">Waiting on them</div>
        ${sent.map(m=>`
        <div class="match-item pending-item">
          <div class="mi-top-row">
            ${avatarHTML(m.other, 36)}
            <div>
              <div class="mi-name">${esc(m.other.name)}</div>
              <div class="mi-sub">Pending — they haven't responded yet</div>
            </div>
          </div>
        </div>`).join('')}` : ''}

        ${accepted.length ? `
        <div class="match-section-label">Matches</div>
        ${accepted.map(m=>`
        <div class="match-item ${state.activeChatWith===m.other.name?'active':''}" data-open="${esc(m.other.name)}">
          <div class="mi-top-row">
            ${avatarHTML(m.other, 36)}
            <div>
              <div class="mi-name">${esc(m.other.name)}</div>
              <div class="mi-sub">${m.other.sports.map(s=>sportById(s).emoji).join(' ')}</div>
            </div>
          </div>
        </div>`).join('')}` : ''}
      `}
    </div>
    <div class="chat-panel">
      ${!state.activeChatWith ? `<div class="empty-state" style="margin:auto;border:none;background:none;">Pick a match to start chatting.</div>` : `
      <div class="chat-header">
        <div class="chat-header-row">
          ${avatarHTML(chatOther, 32)}
          <div>
            <div>${esc(state.activeChatWith)}</div>
            <div class="ch-sub">Private conversation</div>
          </div>
        </div>
      </div>
      <div class="chat-body" id="chat-body">
        ${state.chatLoading ? `<div style="color:var(--ink-dim);font-size:13px;">Loading messages…</div>` :
          state.chatMessages.length===0 ? `<div style="color:var(--ink-dim);font-size:13px;">Say hi 👋 — you matched over a shared sport.</div>` :
          state.chatMessages.map(m=>{
            const side = m.from === 'me' ? 'me' : 'them';
            const senderName = m.from === 'me' ? state.session.name : state.activeChatWith;
            const senderUser = m.from === 'me' ? state.session : chatOther;
            return `
          <div class="msg-group ${side}">
            <div class="msg-sender-row">
              ${avatarHTML(senderUser, 20)}
              <div class="msg-sender">${esc(senderName)}</div>
            </div>
            <div class="msg ${side}">
              ${esc(m.text)}
              <span class="ts">${new Date(m.ts).toLocaleString([], {hour:'2-digit',minute:'2-digit'})}</span>
            </div>
          </div>`;
          }).join('')
        }
      </div>
      <div class="chat-input-row">
        <input id="chat-input" type="text" placeholder="Type a message…" />
        <button class="btn btn-lime" id="chat-send">Send</button>
      </div>`}
    </div>
  </div>`;
}

async function render(){
  const app = document.getElementById('app');

  // Modals and toasts get appended directly to document.body (outside
  // #app) further down, so rebuilding #app's innerHTML never touches
  // them. Without this cleanup, closing a modal (or any background
  // re-render while one is open) leaves the old overlay stuck on screen
  // permanently, blocking the whole page.
  document.querySelectorAll('.modal-backdrop, .toast').forEach(el => el.remove());

  // The whole screen gets rebuilt from scratch on every state change,
  // including on unrelated background events (a live chat push, a toast,
  // a match notification). The chat input isn't bound to state, so
  // without this it would silently lose whatever you were mid-typing the
  // instant any of those fired. Snapshot it here and restore it below.
  const prevChatInput = document.getElementById('chat-input');
  const savedChatInput = prevChatInput ? {
    value: prevChatInput.value,
    start: prevChatInput.selectionStart,
    end: prevChatInput.selectionEnd,
    focused: document.activeElement === prevChatInput,
  } : null;

  if(state.screen !== 'app'){
    app.innerHTML = renderAuth();
    wireAuthEvents();
    return;
  }

  const self = state.session;

  let tabContent = '';
  if(state.tab === 'discover') tabContent = renderDiscover(self);
  else if(state.tab === 'search') tabContent = renderSearch();
  else if(state.tab === 'matches') tabContent = renderMatches();
  else if(state.tab === 'profile') tabContent = renderProfile(self);

  app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">Q</div>
        <div>
          <div class="brand-name display">Quest Fit</div>
          <div class="brand-tag">Find your next teammate</div>
        </div>
      </div>
      <div class="user-pill">
        <button class="user-pill-clickable" id="edit-profile-btn">
          ${avatarHTML(self, 30)}
          <span>${esc(self.name)}</span>
        </button>
        <span class="who">${self.sports.map(s=>sportById(s).emoji).join('')}</span>
        <button class="btn btn-ghost btn-sm" id="logout-btn">Log out</button>
      </div>
    </div>
    <div class="tabs">
      <div class="tab ${state.tab==='discover'?'active':''}" data-tab="discover">Discover</div>
      <div class="tab ${state.tab==='search'?'active':''}" data-tab="search">Search</div>
      <div class="tab ${state.tab==='matches'?'active':''}" data-tab="matches">Matches<span class="count">${state.myMatches.incoming.length||''}</span></div>
      <div class="tab ${state.tab==='profile'?'active':''}" data-tab="profile">Profile</div>
    </div>
    ${tabContent}
    <div class="footer-note">Quest Fit · running on your own server, data stored in a cloud Postgres database.</div>
  `;

  if(state.matchModal){
    const other = state.matchModal;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="match-backdrop">
        <div class="modal-card">
          <div class="display">It's a match!</div>
          <p>You and ${esc(other.name)} both like ${sportById(other.sports.find(s=>self.sports.includes(s)))?.label || 'the same sport'}. Say hello.</p>
          <button class="btn btn-lime btn-block" id="modal-chat-btn">Start chatting</button>
          <button class="btn btn-ghost btn-block" id="modal-close-btn" style="margin-top:10px;">Keep browsing</button>
        </div>
      </div>`);
    document.getElementById('modal-chat-btn').onclick = async ()=>{
      setState({matchModal:null, tab:'matches'});
      await loadMyMatches();
      await openChat(other.name);
    };
    document.getElementById('modal-close-btn').onclick = ()=> setState({matchModal:null});
  }

  if(state.viewingProfile){
    document.body.insertAdjacentHTML('beforeend', renderProfileViewModal());
    const u = state.viewingProfile;
    document.getElementById('profile-view-close-btn').onclick = closeProfileView;
    document.getElementById('profile-view-match-btn').onclick = ()=> matchFromProfileView(u.name);
  }

  if(state.addPostModalOpen && state.addPostForm){
    const f = state.addPostForm;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="add-post-backdrop">
        <div class="modal-card profile-modal">
          <div class="display" style="font-size:22px;margin-bottom:14px;">New post</div>
          ${state.addPostError ? `<div class="error-box">${esc(state.addPostError)}</div>` : ''}

          <div class="post-photo-picker">
            ${f.imageDataUrl
              ? `<img src="${f.imageDataUrl}" class="post-photo-preview" alt="Selected photo" />`
              : `<label for="post-photo-input" class="post-photo-placeholder">Tap to choose a photo</label>`
            }
            <input type="file" id="post-photo-input" accept="image/*" style="display:none;" />
          </div>
          ${f.imageDataUrl ? `<label class="btn btn-ghost btn-sm" for="post-photo-input" style="cursor:pointer;margin-top:10px;display:inline-block;">Choose a different photo</label>` : ''}

          <div class="field" style="margin-top:14px;">
            <label>Caption (optional)</label>
            <textarea id="post-caption" rows="2" maxlength="${MAX_POST_CAPTION_LENGTH}" placeholder="Say something about it...">${esc(f.caption)}</textarea>
            <div class="hint" id="post-caption-counter">${f.caption.length}/${MAX_POST_CAPTION_LENGTH}</div>
          </div>

          <button class="btn btn-lime btn-block" id="post-submit-btn" ${state.addPostSaving?'disabled':''}>${state.addPostSaving ? 'Posting…' : 'Post'}</button>
          <button class="btn btn-ghost btn-block" id="post-cancel-btn" style="margin-top:10px;">Cancel</button>
        </div>
      </div>`);

    document.getElementById('post-cancel-btn').onclick = closeAddPostModal;
    document.getElementById('post-submit-btn').onclick = submitPost;
    document.getElementById('post-photo-input').onchange = (e) => handlePostPhotoFile(e.target.files[0]);
    const captionInput = document.getElementById('post-caption');
    captionInput.oninput = () => {
      state.addPostForm.caption = captionInput.value;
      document.getElementById('post-caption-counter').textContent = `${captionInput.value.length}/${MAX_POST_CAPTION_LENGTH}`;
    };
  }

  if(state.toast){
    document.body.insertAdjacentHTML('beforeend', `<div class="toast">${esc(state.toast)}</div>`);
  }

  if(state.profileModalOpen && state.profileForm){
    const f = state.profileForm;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" id="profile-backdrop">
        <div class="modal-card profile-modal">
          <div class="display" style="font-size:22px;margin-bottom:14px;">Edit profile</div>
          ${state.profileError ? `<div class="error-box">${esc(state.profileError)}</div>` : ''}

          <div class="profile-photo-row">
            ${f.photoDataUrl
              ? `<img src="${f.photoDataUrl}" class="avatar-img" style="width:76px;height:76px;" alt="Your photo" />`
              : `<div class="avatar-emoji" style="width:76px;height:76px;font-size:38px;background:${f.avatarColor}22;border-color:${f.avatarColor}55;">${f.avatarEmoji}</div>`
            }
            <div class="profile-photo-actions">
              <label class="btn btn-ghost btn-sm" for="photo-file-input" style="cursor:pointer;">Upload photo</label>
              <input type="file" id="photo-file-input" accept="image/*" style="display:none;" />
              ${f.photoDataUrl ? `<button class="btn btn-ghost btn-sm" id="remove-photo-btn">Remove photo</button>` : ''}
            </div>
          </div>

          <div class="field">
            <label>Avatar (used when you don't have a photo)</label>
            <div class="chip-grid">
              ${AVATAR_EMOJIS.map(e=>`<div class="emoji-chip ${f.avatarEmoji===e?'selected':''}" data-avatar-emoji="${e}">${e}</div>`).join('')}
            </div>
          </div>

          <div class="field">
            <label>Accent color</label>
            <div class="color-swatch-row">
              ${ACCENT_COLORS.map(c=>`<div class="color-swatch ${f.avatarColor===c?'selected':''}" data-avatar-color="${c}" style="background:${c};"></div>`).join('')}
            </div>
          </div>

          <div class="field">
            <label>Title</label>
            <select id="profile-title">
              ${TITLES.map(t=>`<option value="${esc(t)}" ${f.title===t?'selected':''}>${t || 'No title'}</option>`).join('')}
            </select>
          </div>

          <div class="field">
            <label>Bio</label>
            <textarea id="profile-bio" rows="3" maxlength="${MAX_BIO_LENGTH}" placeholder="Tell people what you're about...">${esc(f.bio)}</textarea>
            <div class="hint" id="bio-counter">${f.bio.length}/${MAX_BIO_LENGTH}</div>
          </div>

          <button class="btn btn-lime btn-block" id="profile-save-btn" ${state.profileSaving?'disabled':''}>${state.profileSaving ? 'Saving…' : 'Save profile'}</button>
          <button class="btn btn-ghost btn-block" id="profile-cancel-btn" style="margin-top:10px;">Cancel</button>
        </div>
      </div>`);

    document.getElementById('profile-cancel-btn').onclick = closeProfileModal;
    document.getElementById('profile-save-btn').onclick = saveProfile;
    document.getElementById('photo-file-input').onchange = (e) => handlePhotoFile(e.target.files[0]);
    const removeBtn = document.getElementById('remove-photo-btn');
    if(removeBtn) removeBtn.onclick = () => setState({profileForm:{...state.profileForm, photoDataUrl:null}});

    document.querySelectorAll('[data-avatar-emoji]').forEach(chip=>{
      chip.onclick = () => setState({profileForm:{...state.profileForm, avatarEmoji: chip.getAttribute('data-avatar-emoji')}});
    });
    document.querySelectorAll('[data-avatar-color]').forEach(sw=>{
      sw.onclick = () => setState({profileForm:{...state.profileForm, avatarColor: sw.getAttribute('data-avatar-color')}});
    });
    document.getElementById('profile-title').onchange = (e) => { state.profileForm.title = e.target.value; };
    const bioInput = document.getElementById('profile-bio');
    bioInput.oninput = () => {
      state.profileForm.bio = bioInput.value;
      document.getElementById('bio-counter').textContent = `${bioInput.value.length}/${MAX_BIO_LENGTH}`;
    };
  }

  wireAppEvents();

  if(state.tab === 'discover' && state.discoverQueue === null && !state.discoverLoading){
    loadDiscoverQueue();
  }
  if(state.tab === 'matches' && state.matchesLoading){
    loadMyMatches();
  }
  if(state.tab === 'profile' && state.matchesLoading){
    loadMyMatches();
  }
  if(state.tab === 'profile' && state.myPostsLoading){
    loadMyPosts();
  }
  const chatBody = document.getElementById('chat-body');
  if(chatBody) chatBody.scrollTop = chatBody.scrollHeight;

  if(savedChatInput){
    const newChatInput = document.getElementById('chat-input');
    if(newChatInput){
      newChatInput.value = savedChatInput.value;
      if(savedChatInput.focused){
        newChatInput.focus();
        try{ newChatInput.setSelectionRange(savedChatInput.start, savedChatInput.end); }catch(e){}
      }
    }
  }
}

function wireAuthEvents(){
  const byId = id => document.getElementById(id);

  document.querySelectorAll('.pw-toggle').forEach(btn=>{
    btn.onclick = ()=>{
      const input = byId(btn.getAttribute('data-target'));
      const nowVisible = input.type === 'password';
      input.type = nowVisible ? 'text' : 'password';
      btn.textContent = nowVisible ? 'Hide' : 'Show';
      input.focus();
      const pos = input.value.length;
      input.setSelectionRange(pos, pos);
    };
  });

  if(state.screen === 'signup'){
    byId('go-login').onclick = ()=> setState({screen:'login', authError:''});
    byId('su-submit').onclick = handleSignup;
    document.querySelectorAll('.chip').forEach(chip=>{
      chip.onclick = ()=>{
        const id = chip.getAttribute('data-sport');
        const cur = state.signupForm.sports;
        const next = cur.includes(id) ? cur.filter(s=>s!==id) : [...cur, id];
        setState({signupForm:{...state.signupForm, sports:next}});
      };
    });
    ['name','email','password','confirm','age'].forEach(field=>{
      const el = byId('su-'+field);
      el.oninput = ()=>{ state.signupForm[field]=el.value; };
      el.onblur = ()=>{ setState({signupForm:{...state.signupForm, [field]: el.value}}); };
    });
    byId('su-gender').onchange = (e)=> setState({signupForm:{...state.signupForm, gender:e.target.value}});
  } else if(state.screen === 'login') {
    byId('go-signup').onclick = ()=> setState({screen:'signup', authError:''});
    byId('li-submit').onclick = handleLogin;
    ['email','password'].forEach(field=>{
      const el = byId('li-'+field);
      el.oninput = ()=>{ state.loginForm[field]=el.value; };
      el.addEventListener('keydown', e=>{ if(e.key==='Enter') handleLogin(); });
    });
  }
}

function wireAppEvents(){
  const byId = id => document.getElementById(id);
  byId('logout-btn').onclick = handleLogout;
  byId('edit-profile-btn').onclick = openProfileModal;
  document.querySelectorAll('.tab').forEach(t=>{
    t.onclick = ()=>{
      const tab = t.getAttribute('data-tab');
      setState({tab});
      if(tab === 'matches') refreshMyMatches();
    };
  });

  if(state.tab === 'discover'){
    const passBtn = byId('btn-pass'), matchBtn = byId('btn-match');
    if(passBtn) passBtn.onclick = ()=> swipe('pass');
    if(matchBtn) matchBtn.onclick = ()=> swipe('match');
  }

  if(state.tab === 'search'){
    byId('sf-submit').onclick = ()=>{
      const filters = {
        sport: byId('sf-sport').value,
        minAge: byId('sf-minage').value,
        maxAge: byId('sf-maxage').value,
        name: byId('sf-name').value,
      };
      setState({searchFilters:filters});
      runSearch();
    };
    document.querySelectorAll('[data-match]').forEach(b=>{
      b.onclick = ()=> matchFromSearch(b.getAttribute('data-match'));
    });
    document.querySelectorAll('[data-view-profile]').forEach(el=>{
      el.onclick = ()=>{
        const name = el.getAttribute('data-view-profile');
        const user = (state.searchResults || []).find(u => u.name === name);
        if(user) openProfileView(user);
      };
    });
  }

  if(state.tab === 'profile'){
    const editBtn = byId('profile-page-edit-btn');
    if(editBtn) editBtn.onclick = openProfileModal;
    const addPostBtn = byId('add-post-btn');
    if(addPostBtn) addPostBtn.onclick = openAddPostModal;
    document.querySelectorAll('[data-delete-post]').forEach(btn=>{
      btn.onclick = (e)=>{ e.stopPropagation(); deletePost(btn.getAttribute('data-delete-post')); };
    });
  }

  if(state.tab === 'matches'){
    document.querySelectorAll('[data-open]').forEach(item=>{
      item.onclick = ()=> openChat(item.getAttribute('data-open'));
    });
    document.querySelectorAll('[data-accept]').forEach(btn=>{
      btn.onclick = (e)=>{
        e.stopPropagation();
        acceptMatchRequest(btn.getAttribute('data-accept'), btn.getAttribute('data-accept-name'));
      };
    });
    document.querySelectorAll('[data-decline]').forEach(btn=>{
      btn.onclick = (e)=>{
        e.stopPropagation();
        declineMatchRequest(btn.getAttribute('data-decline'));
      };
    });
    const sendBtn = byId('chat-send'), input = byId('chat-input');
    if(sendBtn){
      const doSend = ()=> sendMessage(input.value, input);
      sendBtn.onclick = doSend;
      input.addEventListener('keydown', e=>{
        if(e.key==='Enter') doSend();
      });
    }
  }
}

checkSession();
