const make = (tag, text) => {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
};

export function connectProjects({launcher, flush, error}) {
  const desktop = window.desktop;
  launcher.hidden = !desktop;
  if (!desktop) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'projects-dialog';
  dialog.setAttribute('aria-labelledby', 'projects-title');
  dialog.innerHTML = `
    <header class="dialog-heading">
      <h2 id="projects-title">Projects</h2>
      <button type="button" data-close>Close</button>
    </header>
    <div role="group" aria-label="Project options" class="project-options">
      <button type="button" data-saved aria-pressed="true">Saved projects</button>
      <button type="button" data-find aria-pressed="false">Find on this computer</button>
    </div>
    <section data-saved-panel>
      <label for="projects-search">Filter saved projects</label>
      <input id="projects-search" type="search" placeholder="Name or folder">
      <div data-projects></div>
    </section>
    <section data-find-panel hidden>
      <ol class="project-chat" aria-label="Project search conversation" aria-live="polite"></ol>
      <form>
        <label for="project-query">Describe the project</label>
        <div class="project-query-row">
          <input id="project-query" required maxlength="500" placeholder="Project name, folder, or description">
          <button type="submit">Send</button>
        </div>
      </form>
      <div data-matches></div>
    </section>
    <button type="button" data-add>Browse for a folder</button>
    <p role="status" data-status></p>
    <button type="button" data-retry hidden>Retry</button>`;
  document.body.append(dialog);

  const $ = selector => dialog.querySelector(selector);
  const savedList = $('[data-projects]');
  const filter = $('#projects-search');
  const status = $('[data-status]');
  const chat = $('.project-chat');
  const query = $('#project-query');
  const matches = $('[data-matches]');
  const send = $('button[type="submit"]');
  const retry = $('[data-retry]');
  let recent = [];
  let messages = [];
  let searching = false;
  let opening = false;

  function failed(issue, action) {
    status.textContent = issue.message;
    retry.hidden = false;
    retry.onclick = action;
  }

  function showSearch(show) {
    $('[data-saved-panel]').hidden = show;
    $('[data-find-panel]').hidden = !show;
    $('[data-saved]').setAttribute('aria-pressed', String(!show));
    $('[data-find]').setAttribute('aria-pressed', String(show));
    status.textContent = '';
    retry.hidden = true;
    (show ? query : filter).focus();
  }

  async function openProject(project, discovered = false) {
    if (opening || searching) return;
    opening = true;
    try {
      if (!await flush()) return;
      status.textContent = 'Opening project…';
      retry.hidden = true;
      await desktop.chooseRepository(project, discovered);
      status.textContent = '';
    } catch (issue) {
      failed(issue, () => openProject(project, discovered));
    } finally {
      opening = false;
    }
  }

  function projectRow(project, discovered) {
    const row = make('article', '');
    row.className = 'project-row';
    const open = make('button', '');
    open.type = 'button';
    open.className = 'project-open';
    open.disabled = project.current || project.available === false;
    const state = project.current ? 'Current project' : project.available === false ? 'Folder not found' :
      project.recommended ? 'Suggested match' : project.checkout === 'worktree' ? 'Linked worktree' : 'Open project';
    open.append(make('strong', project.name), make('small', project.path), make('span', state));
    open.onclick = () => openProject(project.path, discovered);
    row.append(open);
    if (!discovered && !project.current) {
      if (!project.available) {
        const locate = make('button', 'Locate folder');
        locate.onclick = () => openProject();
        row.append(locate);
      }
      const remove = make('button', 'Remove from list');
      remove.onclick = async () => {
        try {
          await desktop.forgetProject(project.path);
          recent = await desktop.recentProjects();
          renderSaved();
        } catch (issue) { status.textContent = issue.message; }
      };
      row.append(remove);
    }
    return row;
  }

  function renderSaved() {
    const term = filter.value.trim().toLowerCase();
    const results = recent.filter(project => (project.name + ' ' + project.path).toLowerCase().includes(term));
    savedList.replaceChildren(...results.map(project => projectRow(project, false)));
    if (!results.length) savedList.append(make('p', 'No saved projects match.'));
  }

  function say(author, message) {
    const turn = make('li', '');
    turn.append(make('strong', author), make('p', message));
    chat.append(turn);
    chat.scrollTop = chat.scrollHeight;
  }

  async function search(message, repeat = false) {
    if (!message || searching || opening) return;
    searching = send.disabled = true;
    retry.hidden = true;
    query.value = '';
    if (!repeat) {
      say('You', message);
      messages = [...messages.slice(-14), {role: 'user', text: message}];
    }
    matches.replaceChildren();
    status.textContent = 'Searching for local Git projects…';
    try {
      const reply = await desktop.findProjects(messages);
      say('Project finder', reply.message);
      messages.push({role: 'assistant', text: reply.message});
      matches.append(...reply.projects.map(project => projectRow(project, true)));
      status.textContent = '';
    } catch (issue) {
      failed(issue, () => search(message, true));
    } finally {
      searching = send.disabled = false;
    }
  }
  $('form').onsubmit = event => {
    event.preventDefault();
    return search(query.value.trim());
  };

  filter.oninput = renderSaved;
  $('[data-saved]').onclick = () => showSearch(false);
  $('[data-find]').onclick = () => showSearch(true);
  $('[data-close]').onclick = () => dialog.close();
  $('[data-add]').onclick = () => openProject();
  launcher.onclick = async () => {
    try {
      if (!await flush() || dialog.open) return;
      filter.value = '';
      dialog.showModal();
      showSearch(false);
      await loadSaved();
    } catch (issue) { error(issue.message); }
  };

  async function loadSaved() {
    status.textContent = 'Loading saved projects…';
    retry.hidden = true;
    try {
      recent = await desktop.recentProjects();
      renderSaved();
      status.textContent = '';
    } catch (issue) { failed(issue, loadSaved); }
  }
}
