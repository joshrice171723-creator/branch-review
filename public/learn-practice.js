const keyFor = (section, cue) => section + ':' + cue;
const cueKey = value => keyFor(value.section, value.cue);

export function mountPractice({ request, context, sections, clock, go, pause, status, redrawFlags }) {
  const toolbar = document.createElement('div');
  toolbar.className = 'learn-practice-actions';
  toolbar.innerHTML = `
    <button type="button" data-flag aria-pressed="false" title="Flag this cue (F)">Flag cue</button>
    <button type="button" data-note title="Edit note (Shift+N)">Note</button>
    <button type="button" data-weak aria-pressed="false">Weak spots</button>
    <button type="button" data-quiz aria-pressed="false">Quiz mode</button>
  `;
  document.getElementById('status').before(toolbar);
  const panel = document.createElement('div');
  panel.className = 'learn-practice-panel';
  panel.innerHTML = `
    <p class="learn-practice-note" data-saved-note hidden></p>
    <form data-note-form hidden>
      <label>Note for this cue<textarea data-note-text maxlength="4000" rows="2"></textarea></label>
      <button type="submit">Save note</button> <button type="button" data-cancel-note>Cancel</button>
    </form>
    <form data-quiz-form hidden>
      <p class="learn-practice-topic" data-topic></p>
      <label>Explain what's happening here.<textarea data-answer maxlength="4000" rows="2" placeholder="Optional answer"></textarea></label>
      <button type="submit" class="primary">Reveal</button>
    </form>
    <p class="learn-practice-verdict" data-verdict role="status" hidden></p>
  `;
  document.getElementById('caption').parentElement.after(panel);
  const $ = key => panel.querySelector('[data-' + key + ']') || toolbar.querySelector('[data-' + key + ']');
  const flag = $('flag'), note = $('note'), weak = $('weak'), quiz = $('quiz');
  const noteForm = $('note-form'), noteText = $('note-text'), noteView = $('saved-note');
  const quizForm = $('quiz-form'), answer = $('answer'), verdict = $('verdict');
  let tourId, flags = {}, notes = {}, weakMode = false, quizMode = false, windows = [];
  let question, editing, previous, lastVerdict;
  let answered = new Set(), pending = new Set();

  function active() {
    const value = context();
    return value?.id === tourId && Number.isInteger(value?.cue) && value.cue >= 0 ? value : null;
  }
  const flagged = (section, cue) => Boolean(flags[keyFor(section, cue)]);
  function showText(element, text) {
    element.hidden = !text;
    element.textContent = text || '';
  }
  function redraw() {
    const value = active();
    const key = value ? cueKey(value) : null;
    const marked = key && Boolean(flags[key]);
    flag.disabled = !value;
    note.disabled = !value;
    weak.disabled = !weakMode && windows.length === 0;
    flag.textContent = marked ? 'Unflag cue' : 'Flag cue';
    flag.setAttribute('aria-pressed', String(Boolean(marked)));
    weak.setAttribute('aria-pressed', String(weakMode));
    quiz.setAttribute('aria-pressed', String(quizMode));
    showText(noteView, key && notes[key]);
    showText(verdict, key && lastVerdict?.key === key ? lastVerdict.text : '');
  }
  function refreshWindows() {
    windows = [];
    for (const [section, row] of sections().entries()) {
      for (const [cue, marker] of row.cues.entries()) {
        if (!flagged(section, cue)) continue;
        const start = Math.max(0, marker.atSeconds - 2);
        const end = Math.min(row.durationSecs, (row.cues[cue + 1]?.atSeconds ?? row.durationSecs) + 2);
        if (end <= start) continue;
        const last = windows.at(-1);
        if (last?.section === section && last.end >= start) last.end = Math.max(last.end, end);
        else windows.push({ section, start, end });
      }
    }
  }
  function setTour(data) {
    tourId = data.id;
    flags = { ...data.flags };
    notes = { ...data.notes };
    pending = new Set();
    answered = new Set();
    weakMode = quizMode = false;
    question = editing = previous = lastVerdict = null;
    noteForm.hidden = quizForm.hidden = true;
    refreshWindows();
    redraw();
  }
  function cueChanged() {
    const value = active();
    const key = value ? cueKey(value) : null;
    if (editing && cueKey(editing) !== key) {
      editing = null;
      noteForm.hidden = true;
    }
    if (question && cueKey(question) !== key) {
      question = null;
      quizForm.hidden = true;
    }
    redraw();
  }
  async function setFlag() {
    const value = active();
    if (!value) return;
    const key = cueKey(value);
    if (pending.has(key)) return;
    const requests = pending;
    const marked = !flags[key];
    requests.add(key);
    try {
      await request('practice/flag', { id: value.id, section: value.section, cue: value.cue, flag: marked });
      if (requests !== pending) return;
      if (marked) flags[key] = true;
      else delete flags[key];
      refreshWindows();
      redraw();
      redrawFlags();
      check();
    } catch (error) { status(error.message); }
    finally { requests.delete(key); }
  }
  function editNote() {
    editing = active();
    if (!editing) return;
    pause();
    noteText.value = notes[cueKey(editing)] || '';
    noteForm.hidden = false;
    noteText.focus();
  }
  $('cancel-note').onclick = () => { editing = null; noteForm.hidden = true; };
  noteForm.onsubmit = async event => {
    event.preventDefault();
    if (!editing) return;
    const value = editing;
    const key = cueKey(value);
    const text = noteText.value.trim();
    try {
      await request('practice/note', { id: value.id, section: value.section, cue: value.cue, note: text });
      if (value.id !== tourId) return;
      if (text) notes[key] = text;
      else delete notes[key];
      if (editing === value) {
        editing = null;
        noteForm.hidden = true;
      }
      redraw();
    } catch (error) { status(error.message); }
  };
  function finishWeak() {
    weakMode = false;
    pause();
    redraw();
    status('Weak spots finished.');
  }
  function moveWeak(window) {
    if (!window) return finishWeak();
    go(window.section, window.start, true);
  }
  function toggleWeak() {
    if (weakMode) {
      weakMode = false;
      redraw();
      return;
    }
    if (!windows.length) return;
    quizMode = false;
    question = null;
    quizForm.hidden = true;
    weakMode = true;
    redraw();
    moveWeak(windows[0]);
  }
  function toggleQuiz() {
    quizMode = !quizMode;
    previous = null;
    answered = new Set();
    if (quizMode) weakMode = false;
    else {
      question = null;
      quizForm.hidden = true;
    }
    redraw();
  }
  function check() {
    if (!weakMode && !quizMode) return;
    const state = clock();
    if (!state?.playing || state.seeking) {
      previous = null;
      return;
    }
    if (weakMode) {
      const window = windows.find(row => row.section > state.section ||
        (row.section === state.section && Math.min(state.duration || row.end, row.end) > state.seconds));
      if (!window || window.section !== state.section || state.seconds < window.start) moveWeak(window);
      return;
    }
    if (question) {
      pause();
      return;
    }
    const row = sections()[state.section];
    const rate = state.rate || 1;
    const floor = previous?.section === state.section && previous.seconds <= state.seconds ?
      previous.seconds - 0.001 : state.seconds - Math.max(0.15, 0.1 * rate);
    const ceiling = state.seconds + Math.min(0.15, 0.05 * rate);
    previous = state;
    const index = row?.cues.findIndex((marker, index) => marker.atSeconds >= floor &&
      marker.atSeconds <= ceiling && marker.atSeconds !== row.cues[index + 1]?.atSeconds &&
      !answered.has(keyFor(state.section, index))) ?? -1;
    if (index < 0) return;
    const marker = row.cues[index];
    question = { id: tourId, section: state.section, cue: index, atSeconds: marker.atSeconds };
    answered.add(cueKey(question));
    pause();
    go(question.section, question.atSeconds, false);
    $('topic').textContent = marker.note;
    answer.value = '';
    quizForm.hidden = false;
    answer.focus();
  }
  quizForm.onsubmit = event => {
    event.preventDefault();
    if (!question) return;
    const value = question, text = answer.value.trim(), key = cueKey(value);
    question = null;
    quizForm.hidden = true;
    previous = null;
    if (text) {
      const grading = lastVerdict = { key, text: 'Checking answer…' };
      request('tutor', { id: value.id, section: value.section, cue: value.cue, question: text, grade: true })
        .then(result => { grading.text = result?.display || result?.message || 'Tutor feedback unavailable.'; })
        .catch(error => { grading.text = error.message || 'Tutor feedback unavailable.'; })
        .finally(() => { if (lastVerdict === grading) redraw(); });
    }
    go(value.section, value.atSeconds, true);
    redraw();
  };
  function ended() {
    if (!weakMode) return false;
    const next = windows.find(window => window.section > clock().section);
    moveWeak(next);
    return true;
  }
  flag.onclick = setFlag;
  note.onclick = editNote;
  weak.onclick = toggleWeak;
  quiz.onclick = toggleQuiz;
  function key(event) {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        event.target?.closest?.('input, textarea, select, [contenteditable]')) return false;
    const letter = event.key.toLowerCase();
    if (letter === 'f' && !event.shiftKey && active()) void setFlag();
    else if (letter === 'n' && event.shiftKey && active()) editNote();
    else return false;
    event.preventDefault();
    return true;
  }
  return { setTour, cueChanged, check, key, flagged, ended };
}
