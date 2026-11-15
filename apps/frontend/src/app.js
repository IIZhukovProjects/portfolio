const profile = {};
let contentRevision = 0;
let contentReady = false;
let contentLoading = true;

const content = document.querySelector('#content');
const profileSkeleton = content.querySelector('.skeleton')?.outerHTML;
const contentCacheKey = 'portfolio:public-content:v1';
const contentCacheTtl = 120_000;
const isAdminPage = /\/admin(?:\/index\.html|\/)?$/.test(location.pathname);
const photoUrl = new URL('photo.jpg', document.currentScript.src).href;
let editorEnabled = false;
const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => escapes[char]);

function safeUrl(value, image = false) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return '';
  if (!image && /^#[a-z0-9/-]+$/i.test(value)) return value;
  if (/^\/(?!\/)/.test(value)) return value;
  if (image && location.protocol === 'file:' && /^blob:/.test(value)) return value;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) || (!image && url.protocol === 'mailto:')) return url.href;
  } catch {}
  return '';
}

const markdownTags = new Set('a blockquote br code del em h1 h2 h3 h4 h5 h6 hr img li ol p pre strong table tbody td th thead tr ul'.toUpperCase().split(' '));
const detectedCodeLanguages = ['python', 'javascript', 'typescript', 'json', 'bash', 'sql', 'html', 'css', 'go', 'java', 'yaml'];

function highlightCode(code, language) {
  const source = code.textContent
    .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
  code.textContent = source;
  if (!source || source.length > 20000 || typeof hljs === 'undefined') return;
  if (language && !hljs.getLanguage(language)) return;
  const result = language
    ? hljs.highlight(source, {language, ignoreIllegals: true})
    : hljs.highlightAuto(source, detectedCodeLanguages);
  code.innerHTML = result.value;
}

function renderMarkdown(source) {
  const template = document.createElement('template');
  template.innerHTML = marked.parse(source);
  const codeBlocks = [];
  for (const element of template.content.querySelectorAll('*')) {
    if (!markdownTags.has(element.tagName)) {
      element.remove();
      continue;
    }
    const urlName = element.tagName === 'IMG' ? 'src' : 'href';
    const url = safeUrl(element.getAttribute(urlName), element.tagName === 'IMG');
    const alt = element.getAttribute('alt');
    if (element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE') {
      const language = element.getAttribute('class')?.match(/(?:^|\s)language-([\w+-]+)(?=\s|$)/i)?.[1];
      codeBlocks.push([element, language?.toLowerCase()]);
    }
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (url) element.setAttribute(urlName, url);
    if (alt !== null && element.tagName === 'IMG') element.setAttribute('alt', alt);
    if (element.tagName === 'IMG' && !url) element.remove();
  }
  for (const [code, language] of codeBlocks) highlightCode(code, language);
  return template.innerHTML;
}

function editField(index, type = 'label') {
  return editorEnabled ? ` data-edit-field="${index}" data-edit-type="${type}"` : '';
}

function editEntry(key) {
  return editorEnabled ? ` data-edit-entry="${key}"` : '';
}

function adminPage() {
  const denied = new URLSearchParams(location.search).get('error') === 'forbidden';
  const local = location.protocol === 'file:';
  const backUrl = !local ? '/' : new URL('index.html', photoUrl).href;
  return `<section class="admin-card" aria-labelledby="admin-title">
    <span class="admin-mark" aria-hidden="true">
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></svg>
    </span>
    <h1 id="admin-title" tabindex="-1">Вход в редактор</h1>
    <p class="admin-description">Войди через платформу с аккаунтом администратора.</p>
    ${denied ? '<p class="admin-error" role="alert">У этого аккаунта нет доступа к редактору.</p>' : ''}
    <a class="admin-login" href="/api/v1/admin/login">Перейти в платформу <span aria-hidden="true">↗</span></a>
  </section>
  <a class="admin-back" href="${escapeHtml(backUrl)}"><span aria-hidden="true">←</span> На визитку</a>`;
}
const navigation = [...document.querySelectorAll('.navigation a')];

const contactIcons = {
  telegram: '<path d="m3 10 18-7-5 18-4-8-9-3Zm9 3 9-10"/>',
  github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.9a3.4 3.4 0 0 0-.9-2.5c3-.3 6.1-1.5 6.1-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a13.4 13.4 0 0 0-6.7 0C5.7 1.4 4.6 1.7 4.6 1.7a4.8 4.8 0 0 0-.1 3.6 5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.1 6.4 6.1 6.7A3.4 3.4 0 0 0 9 18.1V22"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>'
};

function contactIcon(name) {
  return `<svg class="contact-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${contactIcons[name]}</svg>`;
}

function writeRecord([title, role, dates, description], index) {
  return `<article class="record"${editEntry(`education/${index}`)}>
    <header><h2${editField(0)}>${escapeHtml(title)}</h2><span${editField(2)}>${escapeHtml(dates)}</span></header>
    <p class="record-role"${editField(1)}>${escapeHtml(role)}</p>
    <div class="record-description"${editField(3, 'text')}>${renderMarkdown(description)}</div>
  </article>`;
}

function writeProject(project, level = 'h2') {
  return `<article class="project"${editEntry(`projects/${project.id}`)}>
    <div>
      <${level}${editField(0)}>${escapeHtml(project.name)}</${level}>
      ${project.status ? `<span class="project-status"${editField(2)}>${escapeHtml(project.status)}</span>` : ''}
      <div class="record-description"${editField(1, 'text')}>${renderMarkdown(project.summary)}</div>
    </div>
    ${detailsLink(`#projects/${project.id}`, `Подробнее о проекте ${project.name}`)}
  </article>`;
}

function writeExperience(job) {
  return `<article class="record experience"${editEntry(`experience/${job.id}`)}>
    <div>
      <header><h2${editField(0)}>${escapeHtml(job.name)}</h2><span${editField(3)}>${escapeHtml(job.dates)}</span></header>
      <p class="record-role"${editField(2)}>${escapeHtml(job.role)}</p>
      <div class="record-description"${editField(1, 'text')}>${renderMarkdown(job.summary)}</div>
    </div>
    ${detailsLink(`#experience/${job.id}`, `Подробнее о работе в ${job.name}`)}
  </article>`;
}

function detailsLink(href, label) {
  return `<a class="details-link" href="${href}" aria-label="${escapeHtml(label)}">Подробнее <span aria-hidden="true">→</span></a>`;
}

function detailPage(item, parent) {
  const isProject = parent === '#projects';
  const metadata = isProject
    ? (item.status ? `<p class="detail-meta"${editField(2)}>${escapeHtml(item.status)}</p>` : '')
    : `<p class="detail-meta"><span${editField(2)}>${escapeHtml(item.role)}</span> · <span${editField(3)}>${escapeHtml(item.dates)}</span></p>`;
  return `<article class="detail"${editEntry(`${parent.slice(1)}/${item.id}`)}>
    <a class="back-link" href="${parent}"><span aria-hidden="true">←</span> ${isProject ? 'Все проекты' : 'Весь опыт'}</a>
    <h1 tabindex="-1"${editField(0)}>${escapeHtml(item.name)}</h1>
    ${metadata}
    <div class="detail-text"${editField(isProject ? 3 : 4, 'text')}>${renderMarkdown(item.details.join('\n\n'))}</div>
  </article>`;
}

function recordsPage(title, entries) {
  return `<h1 class="page-title" tabindex="-1">${title}</h1>
    <div class="records">${entries.map(writeRecord).join('')}</div>`;
}

function profileName() {
  const [firstName, ...surname] = profile.name.trim().split(/\s+/);
  return surname.length
    ? `${escapeHtml(firstName)}<br class="mobile-name-break"> ${escapeHtml(surname.join(' '))}`
    : escapeHtml(firstName);
}

const pages = new Map([
  ['#admin', adminPage],
  ['#profile', () => `<div class="profile"${editEntry('profile')}>
    <h1 tabindex="-1"${editField(0)}>${profileName()}</h1>
    <img class="portrait"${editField(2, 'image')} src="${escapeHtml(safeUrl(profile.photo, true) || photoUrl)}" alt="${escapeHtml(profile.name)}" width="152" height="152" fetchpriority="high">
    <div class="profile-copy">
      <div class="intro"${editField(1, 'text')}>${renderMarkdown(profile.intro)}</div>
      <div class="actions">
        ${profile.contacts.map(([label, url, , icon]) => `<a href="${escapeHtml(safeUrl(url))}">${contactIcon(icon)}${escapeHtml(label)}</a>`).join('')}
      </div>
    </div>
  </div>
  <section class="featured" aria-labelledby="featured-title">
    <h2 id="featured-title">Проекты</h2>
    <div class="projects">${profile.projects.slice(0, 3).map(project => writeProject(project, 'h3')).join('')}</div>
    <a class="more" href="#projects">Все проекты <span aria-hidden="true">→</span></a>
  </section>`],
  ['#experience', () => `<h1 class="page-title" tabindex="-1">Опыт работы</h1>
    <div class="records">${profile.experience.map(writeExperience).join('')}</div>`],
  ['#education', () => recordsPage('Образование', profile.education)],
  ['#projects', () => `<h1 class="page-title" tabindex="-1">Проекты</h1>
    <div class="projects">${profile.projects.map(project => writeProject(project)).join('')}</div>`],
  ['#contacts', () => `<h1 class="page-title" tabindex="-1">Контакты</h1>
    <div class="contacts">${profile.contacts.map(([label, url, value, icon], index) => `<div class="contact-entry"${editEntry(`contacts/${index}`)}><a href="${escapeHtml(safeUrl(url))}">
        ${contactIcon(icon)}<span class="contact-text"><strong${editField(0)}>${escapeHtml(label)}</strong><small${editField(2)}>${escapeHtml(value)}</small></span><span aria-hidden="true">↗</span>
      </a></div>`).join('')}
    </div>`]
]);

function replaceContent(result) {
  Object.assign(profile, result.document);
  contentRevision = result.revision;
  contentReady = true;
  for (const route of [...pages.keys()]) {
    if (route.startsWith('#projects/') || route.startsWith('#experience/')) pages.delete(route);
  }
  for (const project of profile.projects) {
    pages.set(`#projects/${project.id}`, () => detailPage(project, '#projects'));
  }
  for (const job of profile.experience) {
    pages.set(`#experience/${job.id}`, () => detailPage(job, '#experience'));
  }
}

function readCachedContent() {
  try {
    const cached = JSON.parse(localStorage.getItem(contentCacheKey));
    const age = Date.now() - cached?.savedAt;
    if (age >= 0 && age < contentCacheTtl) return cached.result;
  } catch {}
}

function cacheContent(result) {
  try {
    localStorage.setItem(contentCacheKey, JSON.stringify({savedAt: Date.now(), result}));
  } catch {}
}

function loadingPage(route) {
  if (route === '#profile' && profileSkeleton) return profileSkeleton;
  const row = '<div class="project skeleton-row"><div><span></span><span></span></div><span></span></div>';
  return `<div class="skeleton" aria-hidden="true">
    <div class="skeleton-line skeleton-heading skeleton-page-title"></div>
    <div class="projects">${row.repeat(route.includes('/') ? 1 : 3)}</div>
  </div>`;
}

function renderPage(focusHeading = false) {
  const requested = isAdminPage && !editorEnabled
    ? '#admin'
    : location.hash || '#profile';
  const hash = pages.has(requested) && (requested !== '#admin' || isAdminPage) ? requested : '#profile';
  document.body.classList.toggle('admin-view', hash === '#admin');
  document.body.classList.toggle('editor-view', editorEnabled && hash !== '#admin');
  const parent = (contentLoading ? requested : hash).split('/')[0];
  for (const link of navigation) {
    if (link.hash === parent) link.setAttribute('aria-current', requested === parent ? 'page' : 'location');
    else link.removeAttribute('aria-current');
  }
  const loading = contentLoading && !contentReady && hash !== '#admin';
  content.setAttribute('aria-busy', String(loading));
  if (loading) {
    content.innerHTML = `<div class="page">${loadingPage(requested)}</div>`;
    return;
  }
  if (!contentReady && hash !== '#admin') {
    content.innerHTML = '<div class="page"><h1>Портфолио</h1><p class="intro">Контент пока недоступен.</p></div>';
    return;
  }
  content.innerHTML = `<div class="page page-enter">${pages.get(hash)()}</div>`;
  content.scrollTop = 0;
  const heading = content.querySelector('h1');
  document.title = hash === '#profile'
    ? 'Илья Жуков · Портфолио'
    : `${heading.textContent} · Илья Жуков`;
  if (focusHeading) heading.focus({preventScroll: true});
}

window.addEventListener('hashchange', () => renderPage(true));
const portfolioReady = (async () => {
  try {
    const cached = !isAdminPage && readCachedContent();
    if (cached) {
      replaceContent(cached);
      return;
    }
    if (isAdminPage || location.hash && location.hash !== '#profile') renderPage();
    const response = await fetch('/api/v1/content', {cache: 'no-store'});
    if (response.ok) {
      const result = await response.json();
      replaceContent(result);
      cacheContent(result);
    }
  } catch {
    // renderPage supplies the unavailable state.
  } finally {
    contentLoading = false;
    renderPage();
  }
})();
