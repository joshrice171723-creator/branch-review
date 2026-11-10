const $ = id => document.getElementById(id);
let token;
async function request(endpoint, data) {
  const response=await fetch('/api/learn/'+endpoint,data===undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json','X-Learn-Token':token},
    body:JSON.stringify(data),keepalive:endpoint==='position',
  });
  const result=await response.json();
  if(!response.ok) throw Error(result.error || 'Learn request failed.');
  return result;
}
const api={
  settings:async()=>{const data=await request('bootstrap');token=data.token;return data;},
  pickFolder:()=>window.learnDesktop.pick('folder'),
  openTour:(tourFolder,repoFolder)=>request('open',{tourFolder,repoFolder}),
  code:file=>request('code?'+new URLSearchParams({id:tour.id,file})),
  preferences:settings=>request('preferences',settings),
  position:position=>request('position',{id:tour.id,position}),
  jump:(section,cue)=>request('jump',{id:tour.id,section,cue}),
};
$('back').onclick=async()=>{
  audio.pause();
  await savePosition(true);
  if(window.learnDesktop) window.learnDesktop.back();
  else location.href='/';
};
window.learnFlush=async()=>{audio.pause();await savePosition(true);};
if(!window.learnDesktop) {
  for(const id of ['tour-path','repo-path']){
    $(id).readOnly=false;
    $(id).oninput=updateFolders;
  }
  $('pick-tour').hidden=$('pick-repo').hidden=true;
}

const audio = $('audio');
let tour;
let sectionIndex = 0;
let activeIndex = -2;
let displayedFile;
let rendered;
let renderRequest = 0;
let pendingSeek;
let resume;
let trackPosition = false;
let lastSaved = '';
let finished = false;
const section = () => tour.sections[sectionIndex];
const time = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
};
const duration = () => Number.isFinite(audio.duration) ? audio.duration : section().durationSecs;
const problem = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const status = value => { $('status').textContent = value; };
const report = error => status(problem(error));

function showSetupError(error) {
  $('setup-error').textContent = error ? problem(error) : '';
  $('setup-error').hidden = !error;
}

function updateFolders() {
  $('open-tour').disabled = !$('tour-path').value || !$('repo-path').value;
}

async function pick(id) {
  try {
    const folder = await api.pickFolder();
    if (folder) $(id).value = folder;
    showSetupError(null);
    updateFolders();
  } catch (error) { showSetupError(error); }
}
$('pick-tour').onclick = () => pick('tour-path');
$('pick-repo').onclick = () => pick('repo-path');
$('folders-button').onclick = () => {
  audio.pause();
  $('setup').hidden = false;
  $('player').hidden = $('player-actions').hidden = true;
  $('cancel-folders').hidden = false;
};
$('cancel-folders').onclick = () => {
  $('tour-path').value = tour.tourFolder;
  $('repo-path').value = tour.repoFolder;
  showSetupError(null);
  $('setup').hidden = true;
  $('player').hidden = $('player-actions').hidden = false;
};
$('folder-form').onsubmit = async event => {
  event.preventDefault();
  $('open-tour').disabled = true;
  showSetupError(null);
  try { await openTour(); }
  catch (error) { showSetupError(error); }
  finally { updateFolders(); }
};

function showResume(position) {
  resume = position && tour.sections[position.section] && Number.isFinite(position.seconds) ? position : null;
  $('resume-panel').hidden = !resume;
  if (resume) $('resume-detail').textContent = tour.sections[resume.section].title + ' · ' + time(resume.seconds);
}

async function openTour() {
  const data = await api.openTour($('tour-path').value, $('repo-path').value);
  tour = data;
  $('setup').hidden = true;
  $('player').hidden = $('player-actions').hidden = false;
  $('warnings').hidden = !tour.warnings.length;
  $('warnings').open = false;
  $('warning-summary').textContent = tour.warnings.length + ' cue files missing or inaccessible';
  $('warning-list').replaceChildren(...tour.warnings.map(warning => {
    const item = document.createElement('li');
    item.textContent = warning;
    return item;
  }));
  $('section-count').textContent = tour.sections.length;
  $('sections').replaceChildren(...tour.sections.map((entry, index) => {
    const number = String(index + 1).padStart(2, '0');
    return listButton('section', number, entry.title, time(entry.durationSecs), () => startSection(index, true));
  }));
  trackPosition = false;
  lastSaved = '';
  displayedFile = undefined;
  showResume(tour.position);
  loadSection(0, 0, false);
}

function listButton(kind, index, label, detail, onClick) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = kind + '-button';
  for (const [className, content] of [['ordinal', index], ['item-label', label], ['item-detail', detail]]) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = content;
    button.append(span);
  }
  button.onclick = onClick;
  item.append(button);
  return item;
}

function markActive(id, index) {
  Array.from($(id).children).forEach((item, i) => {
    if (index === i) item.firstElementChild.setAttribute('aria-current', 'true');
    else item.firstElementChild.removeAttribute('aria-current');
  });
}

function engage() {
  trackPosition = true;
  showResume(null);
  finished = false;
  status('');
}
function savePosition(force = false) {
  if (!trackPosition || finished || !tour || audio.readyState < 1) return;
  const key = sectionIndex + ':' + Math.floor(audio.currentTime / 5);
  if (!force && lastSaved === key) return;
  lastSaved = key;
  return api.position({ section: sectionIndex, seconds: audio.currentTime }).catch(report);
}
function loadSection(index, seconds, play) {
  if (!tour.sections[index]) return;
  audio.pause();
  sectionIndex = index;
  activeIndex = -2;
  pendingSeek = { seconds, play };
  markActive('sections', index);
  $('section-position').textContent = 'Section ' + (index + 1) + ' of ' + tour.sections.length;
  $('cue-count').textContent = section().cues.length;
  $('cues').replaceChildren(...section().cues.map((cue, i) =>
    listButton('cue', String(i + 1).padStart(2, '0'), cue.note, cue.file + ':' + cue.line,
      () => seekTo(cue.atSeconds))));
  audio.src = section().audioUrl;
  audio.load();
  updateTimeline();
  sync();
}
function startSection(index, play) {
  if (!tour.sections[index]) return;
  engage();
  loadSection(index, 0, play);
}
function seekTo(seconds) {
  engage();
  if (pendingSeek) pendingSeek.seconds = seconds;
  if (audio.readyState >= 1) audio.currentTime = Math.max(0, Math.min(seconds, duration()));
  sync();
}

function updateTimeline() {
  const max = duration();
  $('seek').max = max;
  $('seek').value = Math.min(audio.currentTime, max);
  $('elapsed').textContent = time(audio.currentTime);
  $('total').textContent = time(max);
  $('seek').setAttribute('aria-valuetext', time(audio.currentTime) + ' of ' + time(max));
  if ($('markers').dataset.key !== sectionIndex + ':' + max) {
    $('markers').dataset.key = sectionIndex + ':' + max;
    $('markers').replaceChildren(...section().cues.map(cue => {
      const marker = document.createElement('i');
      marker.style.left = Math.min(100, cue.atSeconds / max * 100) + '%';
      return marker;
    }));
  }
}
function cueAt(seconds) {
  const cues = section().cues;
  for (let index = cues.length - 1; index >= 0; index--) {
    if (cues[index].atSeconds <= seconds + 0.15) return index;
  }
  return -1;
}
function sync() {
  if (!tour) return;
  updateTimeline();
  const index = cueAt(audio.currentTime);
  if (index === activeIndex) return;
  activeIndex = index;
  markActive('cues', index);
  $('cues').children[index]?.scrollIntoView({block:'nearest'});
  const cue = section().cues[index];
  $('caption').textContent = cue?.note || 'No cue at this position';
  showCode(cue);
  if (cue && trackPosition && $('ruby-mine').checked) sendJump();
}

function sendJump() {
  const index = activeIndex;
  const section = sectionIndex;
  api.jump(section, index).catch(error => {
    if ($('ruby-mine').checked && sectionIndex === section && activeIndex === index) {
      status('RubyMine: ' + problem(error));
    }
  });
}
function showCodeMessage(message) {
  $('source').hidden = true;
  $('code-message').hidden = false;
  $('code-message').textContent = message;
}
function highlightSource(source) {
  const fragment=document.createDocumentFragment();
  const pattern=/(#[^\n]*|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(def|end|class|module|do|if|else|elsif|unless|while|for|return|yield|require|import|export|async|await|const|let|function|new|true|false|nil|null|raise|rescue)\b|(\b\d+(?:\.\d+)?\b)/g;
  let offset=0;
  for(const match of source.matchAll(pattern)){
    fragment.append(source.slice(offset,match.index));
    const span=document.createElement('span');
    span.className=match[1]?'hljs-comment':match[2]?'hljs-string':match[3]?'hljs-keyword':'hljs-number';
    span.textContent=match[0];
    fragment.append(span);
    offset=match.index+match[0].length;
  }
  fragment.append(source.slice(offset));
  return fragment;
}
async function showCode(cue) {
  const request = ++renderRequest;
  $('file-heading').textContent = cue ? cue.file + ' : ' + cue.line : '—';
  if (!cue) {
    showCodeMessage('No file for this position.');
    return;
  }
  try {
    if (displayedFile !== cue.file) {
      showCodeMessage('Loading file…');
      const code = await api.code(cue.file);
      if (request !== renderRequest) return;
      displayedFile = cue.file;
      rendered = code;
      $('code-text').replaceChildren(highlightSource(code.text));
      const numbers = document.createDocumentFragment();
      for (let line = 1; line <= code.lines; line++) {
        const row = document.createElement('div');
        row.textContent = line;
        numbers.append(row);
      }
      $('gutter').replaceChildren(numbers);
    }
    if (cue.line > rendered.lines) {
      showCodeMessage(cue.note + '\nLine ' + cue.line + ' is outside this file (' + rendered.lines + ' lines).');
      return;
    }
    $('code-message').hidden = true;
    $('source').hidden = false;
    const first = Math.max(1, cue.line - 5);
    const last = Math.min(rendered.lines, cue.line + 5);
    $('source').style.setProperty('--band-start', first - 1);
    $('source').style.setProperty('--band-end', last);
    $('source').style.setProperty('--focus-line', cue.line - 1);
    $('gutter').querySelector('.focused-line')?.classList.remove('focused-line');
    const target = $('gutter').children[cue.line - 1];
    target.classList.add('focused-line');
    const scroll = $('code-scroll');
    scroll.scrollTop = Math.max(0, target.offsetTop - scroll.clientHeight / 3);
    scroll.scrollLeft = 0;
  } catch (error) {
    if (request === renderRequest) showCodeMessage(cue.note + '\nCould not read file: ' + problem(error));
  }
}

audio.addEventListener('loadedmetadata', () => {
  const pending = pendingSeek;
  pendingSeek = null;
  if (pending?.seconds) audio.currentTime = Math.min(pending.seconds, duration());
  sync();
  if (pending?.play) audio.play().catch(report);
});
audio.addEventListener('timeupdate', () => { sync(); savePosition(); });
audio.addEventListener('seeked', () => { sync(); savePosition(true); });
audio.addEventListener('play', () => { $('play').textContent = 'Ⅱ Pause'; savePosition(true); });
audio.addEventListener('pause', () => { $('play').textContent = '▶ Play'; savePosition(true); });
audio.addEventListener('ended', () => {
  if (sectionIndex + 1 < tour.sections.length) startSection(sectionIndex + 1, true);
  else {
    finished = true;
    trackPosition = false;
    status('Tour finished.');
    api.position(null).catch(report);
  }
});
audio.addEventListener('error', () => status('Could not play the section MP3.'));

function togglePlayback() {
  if (!audio.paused) {
    audio.pause();
    return;
  }
  if (finished) {
    startSection(0, true);
    return;
  }
  engage();
  if (pendingSeek) pendingSeek.play = true;
  else audio.play().catch(report);
  if ($('ruby-mine').checked && activeIndex >= 0) sendJump();
}
$('play').onclick = togglePlayback;
$('seek').oninput = () => seekTo(Number($('seek').value));
$('resume').onclick = () => {
  const position = resume;
  engage();
  loadSection(position.section, position.seconds, true);
};
$('dismiss-resume').onclick = () => {
  showResume(null);
  api.position(null).catch(report);
};
$('settings-button').onclick = () => $('settings-dialog').showModal();
$('ruby-mine').onchange = async () => {
  try {
    await api.preferences({ rubyMine: $('ruby-mine').checked });
    status('');
    if ($('ruby-mine').checked && activeIndex >= 0) sendJump();
  } catch (error) { report(error); }
};
$('speed').onchange = () => {
  audio.playbackRate = audio.defaultPlaybackRate = Number($('speed').value);
  api.preferences({ speed: audio.playbackRate }).catch(report);
};
$('volume').oninput = () => { audio.volume = Number($('volume').value); };
$('volume').onchange = () => api.preferences({ volume: audio.volume }).catch(report);

document.addEventListener('keydown', event => {
  if (!tour || $('player').hidden || $('settings-dialog').open ||
      event.altKey || event.ctrlKey || event.metaKey || event.target.matches('input, select, textarea')) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && event.target.matches('button')) return;
  if (![' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'n', 'p'].includes(key)) return;
  event.preventDefault();
  if (key === ' ') togglePlayback();
  else if (key === 'arrowleft') seekTo(audio.currentTime - 10);
  else if (key === 'arrowright') seekTo(audio.currentTime + 10);
  else if (key === 'n') startSection(sectionIndex + 1, !audio.paused);
  else if (key === 'p') startSection(sectionIndex - 1, !audio.paused);
  else {
    const index = activeIndex + (key === 'arrowdown' ? 1 : -1);
    const cue = section().cues[index];
    if (cue) seekTo(cue.atSeconds);
  }
});

(async () => {
  try {
    const settings = await api.settings();
    $('tour-path').value = settings.tourFolder || '';
    $('repo-path').value = settings.repoFolder || '';
    $('ruby-mine').checked = settings.rubyMine === true;
    $('speed').value = settings.speed || 1;
    $('volume').value = settings.volume ?? 1;
    audio.playbackRate = audio.defaultPlaybackRate = Number($('speed').value) || 1;
    audio.volume = Number($('volume').value);
    updateFolders();
    if (!$('open-tour').disabled) await openTour();
  } catch (error) { showSetupError(error); }
})();
