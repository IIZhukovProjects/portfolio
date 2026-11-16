const adminApi = '/api/v1/admin';
let editorSession;
let currentEdit;
let busy = false;

const bar = document.createElement('form');
bar.className = 'inline-editor';
bar.setAttribute('aria-label', 'Правки страницы');
bar.innerHTML = `<div class="inline-controls">
  <button type="button" class="editor-launch" data-start aria-label="Редактировать страницу" title="Редактировать страницу">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6 4 4M4 20l4.5-1 11-11a2.83 2.83 0 0 0-4-4l-11 11L4 20Z"/></svg>
  </button>
  <p class="editor-message" role="status"></p>
  <div class="inline-tools">
    <button type="button" class="editor-button" data-cancel>Отмена</button>
    <button type="submit" class="editor-primary">Сохранить</button>
  </div>
</div>`;
document.body.append(bar);
const message = bar.querySelector('.editor-message');
const save = bar.querySelector('[type="submit"]');
const launch = bar.querySelector('[data-start]');
let imageTarget;

const photoDialog = document.createElement('dialog');
photoDialog.className = 'markdown-source';
photoDialog.setAttribute('aria-label', 'Фото профиля');
photoDialog.innerHTML = `<form method="dialog">
  <label for="photo-source">Адрес картинки</label>
  <input id="photo-source" type="text" inputmode="url" placeholder="https://…">
  <p class="editor-message" role="status"></p>
  <label class="photo-file" hidden>Загрузить с устройства <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"></label>
  <div class="source-tools source-actions">
    <button class="editor-button" value="cancel">Отмена</button>
    <button class="editor-primary" value="apply">Применить</button>
  </div>
</form>`;
document.body.append(photoDialog);
const photoInput = photoDialog.querySelector('#photo-source');
const photoFile = photoDialog.querySelector('[type="file"]');

const labelField = (label, value, optional = false) => ({label, value, optional});
const textField = (label, value) => ({label, value, type: 'text'});

function describeEdit(key, draft) {
  if (key === 'profile') {
    return {
      title: 'Обо мне',
      fields: [labelField('Имя', profile.name), textField('Описание', profile.intro), labelField('Фото', profile.photo || '', true)],
      apply: ([name, intro, photo]) => Object.assign(profile, {name, intro, photo})
    };
  }

  const [section, id] = key.split('/');
  if (section === 'contacts') {
    const item = profile.contacts[id];
    return {
      title: 'Контакт',
      fields: [labelField('Название', item[0]), labelField('Ссылка', item[1]), labelField('Подпись', item[2])],
      apply: values => item.splice(0, 3, ...values),
      validate: values => Boolean(safeUrl(values[1]))
    };
  }
  if (section === 'education') {
    const item = draft || profile.education[id];
    return {
      title: 'Образование',
      fields: [labelField('Учебное заведение', item[0]), labelField('Направление', item[1]), labelField('Период', item[2]), textField('Описание', item[3])],
      apply: values => item.splice(0, 4, ...values)
    };
  }

  const item = draft || profile[section].find(entry => entry.id === id);
  const names = section === 'experience' ? ['name', 'summary', 'role', 'dates'] : ['name', 'summary', 'status'];
  const labels = {name: 'Название', summary: 'Краткое описание', role: 'Должность', dates: 'Период', status: 'Статус'};
  return {
    title: item.name,
    fields: [
      ...names.map(name => name === 'summary' ? textField(labels[name], item[name] || '') : labelField(labels[name], item[name] || '', name === 'status')),
      textField('Подробности', item.details.join('\n\n'))
    ],
    apply(values) {
      for (const [index, name] of names.entries()) item[name] = values[index];
      item.details = [values.at(-1)];
    }
  };
}

function readField(field) {
  if (field.input) return field.input.value;
  if (!field.element || field.type === 'image') return field.value;
  return field.element.textContent.trim();
}

function resetEditor() {
  for (const url of currentEdit?.files.keys() || []) URL.revokeObjectURL(url);
  currentEdit = undefined;
  imageTarget = undefined;
  document.body.classList.remove('inline-editing');
  message.textContent = '';
}

function refreshPage() {
  const scrollPosition = content.scrollTop;
  resetEditor();
  renderPage();
  content.scrollTop = scrollPosition;
  launch.focus({preventScroll: true});
}

function sizeText(input) {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function editText(field) {
  const host = field.element;
  const input = document.createElement('textarea');
  input.className = 'markdown-input';
  input.rows = 1;
  input.value = field.value;
  input.setAttribute('aria-label', field.label);
  host.replaceChildren(input);
  field.input = input;
  sizeText(input);
  input.addEventListener('input', () => sizeText(input));

  const image = document.createElement('button');
  image.type = 'button';
  image.className = 'add-image';
  image.setAttribute('aria-label', 'Добавить картинку');
  image.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 5-4 3 2 5-5 5 5"/></svg> Картинка`;
  host.after(image);
  image.addEventListener('click', () => {
    if (!busy) openPhoto(field);
  });
}

function activateField(field, element) {
  field.element = element;
  const type = element.dataset.editType;
  if (type === 'image') {
    field.type = type;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', 'Заменить фото');
    element.tabIndex = 0;
    return;
  }
  if (type === 'text') {
    editText(field);
    return;
  }
  element.setAttribute('contenteditable', 'plaintext-only');
  element.setAttribute('role', 'textbox');
  element.setAttribute('aria-label', field.label);
  element.tabIndex = 0;
}

function openEditor() {
  if (busy || currentEdit || !editorEnabled) return;
  const section = location.hash.slice(1);
  const edits = [...content.querySelectorAll('[data-edit-entry]')].map(entry => {
    const key = entry.dataset.editEntry;
    const edit = describeEdit(key);
    for (const element of entry.querySelectorAll('[data-edit-field]')) {
      activateField(edit.fields[Number(element.dataset.editField)], element);
    }
    if (key.startsWith('contacts/')) {
      const control = document.createElement('details');
      control.className = 'contact-url';
      control.innerHTML = '<summary>Адрес</summary><label>Адрес ссылки <input type="text" inputmode="url"></label>';
      const input = control.querySelector('input');
      input.value = edit.fields[1].value;
      input.addEventListener('input', () => { edit.fields[1].value = input.value.trim(); });
      entry.append(control);
    }
    return {...edit, key, originalValues: edit.fields.map(field => field.value)};
  });
  if (!edits.length && !['projects', 'education'].includes(section)) return;
  currentEdit = {edits, profileEdit: edits.find(edit => edit.key === 'profile'), files: new Map(), uploads: new Map()};
  document.body.classList.add('inline-editing');
  bar.querySelector('[data-cancel]').focus({preventScroll: true});
  if (!['projects', 'experience', 'education'].includes(section)) return;
  const list = content.querySelector(section === 'projects' ? '.projects' : '.records');
  currentEdit.list = {section, element: list, removed: new Set()};
  for (const entry of list.children) addEntryControls(entry, currentEdit.list);
  if (section === 'projects' || section === 'education') {
    const add = document.createElement('button');
    add.className = 'add-image';
    add.type = 'button';
    add.textContent = section === 'education' ? '+ Добавить образование' : '+ Добавить проект';
    list.after(add);
    add.addEventListener('click', () => {
      if (busy) return;
      if (section === 'education') addEducation(list);
      else addProject(list);
    });
  }
}

function updateMoveControls(list) {
  const rows = [...list.children];
  for (const [index, row] of rows.entries()) {
    row.querySelector('[data-move="up"]').disabled = index === 0;
    row.querySelector('[data-move="down"]').disabled = index === rows.length - 1;
  }
}

function addEntryControls(entry, list) {
  const controls = document.createElement('div');
  controls.className = 'entry-controls';
  const name = entry.querySelector('h2').textContent.trim() || (list.section === 'education' ? 'новая запись' : 'новый проект');
  controls.innerHTML = `<button type="button" data-move="up" aria-label="Переместить выше">↑</button>
    <button type="button" data-move="down" aria-label="Переместить ниже">↓</button>
    <button type="button" data-remove>Удалить</button>`;
  entry.append(controls);
  const up = controls.querySelector('[data-move="up"]');
  const down = controls.querySelector('[data-move="down"]');
  if (up && down) {
    up.setAttribute('aria-label', `Переместить выше: ${name}`);
    down.setAttribute('aria-label', `Переместить ниже: ${name}`);
    up.disabled = !entry.previousElementSibling;
    down.disabled = !entry.nextElementSibling;
  }
  controls.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (busy || !button) return;
    if (button.hasAttribute('data-remove')) {
      const next = entry.nextElementSibling || entry.previousElementSibling;
      const key = entry.dataset.editEntry;
      if (entry.matches('.project-draft, .education-draft')) {
        currentEdit.edits = currentEdit.edits.filter(edit => edit.key !== key);
      } else {
        list.removed.add(key.split('/')[1]);
      }
      entry.remove();
      if (up) updateMoveControls(list.element);
      (next?.querySelector('[data-remove]') || save).focus({preventScroll: true});
      return;
    }
    if (button === up && entry.previousElementSibling) entry.previousElementSibling.before(entry);
    if (button === down && entry.nextElementSibling) entry.nextElementSibling.after(entry);
    updateMoveControls(list.element);
    (button.disabled ? (button === up ? down : up) : button).focus({preventScroll: true});
  });
}

function listChanges(list) {
  if (!list) return {};
  const removed = [...list.removed];
  const order = [...list.element.children].map(entry => entry.dataset.editEntry.split('/')[1]);
  const original = profile[list.section].map((entry, index) => list.section === 'education' ? String(index) : entry.id);
  if (order.length === original.length && order.every((id, index) => id === original[index])) return {};
  if (list.section === 'education') return {educationOrder: order.map(Number), removeEducation: removed.map(Number)};
  return list.section === 'projects'
    ? {projectOrder: order, removeProjects: removed}
    : {experienceOrder: order, removeExperience: removed};
}

function addEducation(list) {
  const id = 'draft-' + crypto.randomUUID();
  const key = 'education/' + id;
  const values = ['', '', '', ''];
  list.insertAdjacentHTML('beforeend', writeRecord(values, id));
  const entry = list.lastElementChild;
  entry.classList.add('education-draft');
  const edit = describeEdit(key, values);
  for (const element of entry.querySelectorAll('[data-edit-field]')) {
    const field = edit.fields[Number(element.dataset.editField)];
    activateField(field, element);
    if (field.input) field.input.placeholder = field.label;
    else element.dataset.placeholder = field.label;
  }
  currentEdit.edits.push({...edit, key, originalValues: values, educationDraft: entry});
  addEntryControls(entry, currentEdit.list);
  updateMoveControls(list);
  entry.querySelector('h2').focus();
}

function addProject(list) {
  const id = 'project-' + crypto.randomUUID().replaceAll('-', '');
  const key = 'projects/' + id;
  const entry = document.createElement('article');
  entry.className = 'record project-draft';
  entry.dataset.editEntry = key;
  entry.innerHTML = `<h2 data-edit-type="label" data-placeholder="Название проекта"></h2>
    <div class="record-description" data-edit-type="text"></div>
    <div class="detail-text" data-edit-type="text"></div>`;
  const edit = describeEdit(key, {id, details: []});
  list.append(entry);
  const [title, summary, details] = entry.children;
  activateField(edit.fields[0], title);
  activateField(edit.fields[1], summary);
  activateField(edit.fields[3], details);
  edit.fields[1].input.placeholder = 'Краткое описание';
  edit.fields[3].input.placeholder = 'Подробности проекта';
  currentEdit.edits.push({...edit, key, originalValues: ['', '', '', '']});
  addEntryControls(entry, currentEdit.list);
  updateMoveControls(list);
  title.focus();
}

launch.addEventListener('click', openEditor);

document.addEventListener('click', event => {
  if (currentEdit && !busy && event.target.closest('[data-edit-type="image"]')) openPhoto();
  if (event.target.closest('[contenteditable]') && event.target.closest('a')) event.preventDefault();

});

content.addEventListener('keydown', event => {
  if (currentEdit && !busy && ['Enter', ' '].includes(event.key) && event.target.matches('[data-edit-type="image"]')) {
    event.preventDefault();
    openPhoto();
    return;
  }
  if (event.key === 'Enter' && !event.isComposing && event.target.matches('[contenteditable="plaintext-only"]')) {
    event.preventDefault();
  }
});
content.addEventListener('beforeinput', event => {
  if (!event.target.matches('[contenteditable="plaintext-only"]')) return;
  if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') event.preventDefault();
});
content.addEventListener('paste', event => {
  const field = event.target.closest('[contenteditable]');
  if (!field) return;
  event.preventDefault();
  const value = event.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, value.replace(/\s*\r?\n\s*/g, ' '));
});
content.addEventListener('drop', event => {
  if (event.target.closest('[contenteditable]')) event.preventDefault();
});
bar.querySelector('[data-cancel]').addEventListener('click', () => {
  if (!busy) refreshPage();
});
window.addEventListener('hashchange', () => {
  if (photoDialog.open) photoDialog.close('cancel');
  if (currentEdit) resetEditor();
});
function openPhoto(field) {
  imageTarget = field;
  photoDialog.setAttribute('aria-label', field ? 'Добавить картинку в текст' : 'Фото профиля');
  photoInput.value = field ? '' : currentEdit.profileEdit.fields[2].value;
  photoDialog.querySelector('.photo-file').hidden = false;
  photoDialog.querySelector('.editor-message').textContent = '';
  photoDialog.returnValue = 'cancel';
  photoDialog.showModal();
}

function applyImage(url) {
  if (!imageTarget) {
    updatePortrait(url);
    return;
  }
  const input = imageTarget.input;
  const description = input.value.slice(input.selectionStart, input.selectionEnd)
    .trim().replace(/[\\\[\]]/g, '\\$&') || 'Изображение';
  const target = url.replace(/[<>]/g, char => encodeURIComponent(char));
  input.setRangeText(`\n![${description}](<${target}>)\n`, input.selectionStart, input.selectionEnd, 'end');
  sizeText(input);
}

photoDialog.addEventListener('close', () => {
  if (photoDialog.returnValue === 'apply') imageTarget?.input.focus({preventScroll: true});
  imageTarget = undefined;
});

photoFile.addEventListener('change', () => {
  const file = photoFile.files[0];
  if (!file || !currentEdit) return;
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
    photoDialog.querySelector('.editor-message').textContent = 'Выбери картинку до 5 МБ в формате JPG, PNG, WebP, GIF или AVIF.';
    return;
  }
  const url = URL.createObjectURL(file);
  currentEdit.files.set(url, file);
  applyImage(url);
  photoFile.value = '';
  photoDialog.close('apply');
});
function updatePortrait(url) {
  currentEdit.profileEdit.fields[2].value = url;
  currentEdit.profileEdit.fields[2].element.src = url || photoUrl;
}
photoDialog.querySelector('form').addEventListener('submit', event => {
  if (event.submitter?.value !== 'apply' || !currentEdit) return;
  const value = photoInput.value.trim();
  const url = safeUrl(value, true);
  if ((value || imageTarget) && !url) {
    event.preventDefault();
    photoDialog.querySelector('.editor-message').textContent = 'Проверь адрес картинки.';
    return;
  }
  applyImage(url);
});

bar.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !currentEdit) return;
  const edit = currentEdit;
  if (edit.list?.section === 'education') {
    let index = profile.education.length;
    for (const entry of edit.edits) {
      if (!entry.educationDraft) continue;
      entry.key = 'education/' + index++;
      entry.educationDraft.dataset.editEntry = entry.key;
    }
  }
  const order = listChanges(edit.list);
  const changes = edit.edits
    .filter(entry => !edit.list?.removed.has(entry.key.split('/')[1]))
    .map(entry => ({entry, values: entry.fields.map(readField)}))
    .filter(({entry, values}) => entry.educationDraft || values.some((value, index) => entry.originalValues[index] !== value));
  if (!changes.length && !Object.keys(order).length) {
    refreshPage();
    return;
  }
  for (const {entry, values} of changes) {
    if (!values.every((value, index) => value.trim() || entry.fields[index].optional)) {
      message.textContent = 'Заполни обязательные поля.';
      return;
    }
    if (entry.validate && !entry.validate(values)) {
      message.textContent = 'Проверь адреса ссылок.';
      return;
    }
  }
  busy = true;
  save.disabled = true;
  try {
    for (const [localUrl, file] of edit.files) {
      if (!changes.some(({values}) => values.some(value => value.includes(localUrl)))) continue;
      if (!edit.uploads.has(localUrl)) {
        const uploaded = await fetch(adminApi + '/media', {
          method: 'POST',
          headers: {'Content-Type': file.type, 'X-CSRF-Token': editorSession.csrf},
          body: file
        });
        if (!uploaded.ok) throw new Error(await requestError(uploaded));
        edit.uploads.set(localUrl, (await uploaded.json()).url);
      }
    }
    const edits = changes.map(({entry, values}) => ({
      key: entry.key,
      values: values.map(value => {
        for (const [localUrl, remoteUrl] of edit.uploads) value = value.replaceAll(localUrl, remoteUrl);
        return value;
      })
    }));
    const response = await fetch(adminApi + '/content', {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': editorSession.csrf},
      body: JSON.stringify({revision: contentRevision, edits, ...order})
    });
    if (!response.ok) throw new Error(await requestError(response));
    const result = await response.json();
    replaceContent(result);
    cacheContent(result);
    if (currentEdit === edit) refreshPage();
    else if (!currentEdit) renderPage();
  } catch (error) {
    if (currentEdit === edit) message.textContent = error.message;
  } finally {
    busy = false;
    save.disabled = false;
  }
});

async function requestError(response) {
  if (response.status === 401 || response.status === 403) {
    return 'Для сохранения войди через платформу как администратор.';
  }
  try {
    const body = await response.json();
    if (typeof body.detail === 'string') return body.detail;
  } catch {}
  return 'Не удалось сохранить изменения. Попробуй ещё раз.';
}

async function connectAdmin() {
  if (location.protocol === 'file:' || !isAdminPage) return;
  try {
    const response = await fetch(adminApi + '/session', {cache: 'no-store'});
    if (!response.ok) return;
    const session = await response.json();
    if (session.isAdmin !== true || typeof session.csrf !== 'string' || !session.csrf) return;
    editorSession = session;
    editorEnabled = true;
    await portfolioReady;
    renderPage();
  } catch {
    // The public UI stays available when the editor API is unavailable.
  }
}

connectAdmin();
