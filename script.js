function parseGithubUrl(url) {
  try {
    const u = new URL(url.trim());
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  } catch {}
  return null;
}

function setStatus(msg, isError = false) {
  const bar = document.getElementById('statusBar');
  const txt = document.getElementById('statusText');
  const spinner = document.getElementById('spinner');
  bar.className = 'status-bar visible' + (isError ? ' error' : '');
  spinner.style.display = isError ? 'none' : 'block';
  txt.textContent = msg;
}

function hideStatus() {
  document.getElementById('statusBar').className = 'status-bar';
}

async function fetchGithub(path, token) {
  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`Error de GitHub: ${res.status} ${res.statusText}`);
  return res.json();
}

async function getRepoTree(owner, repo, token) {
  const repoData = await fetchGithub(`repos/${owner}/${repo}`, token);
  const branch = repoData.default_branch || 'main';
  const tree = await fetchGithub(`repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token);
  return { repoData, files: tree.tree.filter(f => f.type === 'blob') };
}

async function getFileContent(owner, repo, path, token) {
  try {
    const data = await fetchGithub(`repos/${owner}/${repo}/contents/${path}`, token);
    if (data.encoding === 'base64') return atob(data.content.replace(/\n/g, ''));
    return null;
  } catch { return null; }
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function generateDocs() {
  const urlVal = document.getElementById('repoUrl').value.trim();
  const token = document.getElementById('ghToken').value.trim();
  const btn = document.getElementById('genBtn');
  const output = document.getElementById('outputArea');

  if (!urlVal) { alert('Por favor ingresa una URL de GitHub.'); return; }
  const parsed = parseGithubUrl(urlVal);
  if (!parsed) { alert('URL no válida. Usa el formato: https://github.com/usuario/repo'); return; }

  btn.disabled = true;
  output.className = 'output-area';
  output.innerHTML = '';

  try {
    setStatus('Obteniendo información del repositorio…');
    const { repoData, files } = await getRepoTree(parsed.owner, parsed.repo, token);

    const extensionesValidas = ['js','ts','jsx','tsx','py','go','rs','java','c','cpp','cs','rb','php','swift','kt','html','css','json','yaml','yml','md','toml','sh'];
    const archivosFiltrados = files
      .filter(f => {
        const ext = f.path.split('.').pop().toLowerCase();
        return extensionesValidas.includes(ext) && !f.path.includes('node_modules') && !f.path.includes('.git');
      })
      .slice(0, 12);

    setStatus(`Leyendo ${archivosFiltrados.length} archivos…`);
    const contenidos = await Promise.all(
      archivosFiltrados.map(async f => {
        const content = await getFileContent(parsed.owner, parsed.repo, f.path, token);
        return { path: f.path, content: content ? content.slice(0, 1500) : null };
      })
    );
    const archivosValidos = contenidos.filter(f => f.content);

    setStatus('Analizando el proyecto…');
    const listaArchivos = archivosValidos.map(f => `- ${f.path}`).join('\n');
    const muestraCodigo = archivosValidos.slice(0, 3).map(f => `\n### ${f.path}\n\`\`\`\n${f.content.slice(0,500)}\n\`\`\``).join('');

    const promptResumen = `Eres un experto en documentación técnica de software. Analiza este repositorio de GitHub y genera documentación concisa en español.

Repositorio: ${parsed.owner}/${parsed.repo}
Descripción: ${repoData.description || 'Sin descripción'}
Lenguaje: ${repoData.language || 'Desconocido'}
Estrellas: ${repoData.stargazers_count}
Archivos encontrados: ${listaArchivos}

Muestra de código:${muestraCodigo}

Responde SOLO con un objeto JSON (sin markdown, sin comillas triples):
{
  "descripcion": "Descripción del proyecto en 2-3 oraciones",
  "proposito": "Qué problema resuelve este proyecto",
  "tecnologias": ["tec1", "tec2"],
  "instalacion": "Instrucciones breves de instalación",
  "estructura": "Cómo está organizado el código"
}`;

    const resumenRaw = await callClaude(promptResumen);
    let resumen;
    try {
      resumen = JSON.parse(resumenRaw.replace(/```json|```/g, '').trim());
    } catch {
      resumen = {
        descripcion: resumenRaw.slice(0, 300),
        proposito: 'Ver descripción general.',
        tecnologias: [repoData.language || 'Desconocido'],
        instalacion: 'Clona el repositorio y sigue el README.',
        estructura: 'Ver lista de archivos.'
      };
    }

    setStatus(`Documentando ${archivosValidos.length} archivos…`);
    const docsArchivos = await Promise.all(
      archivosValidos.map(async f => {
        const prompt = `Documenta este archivo de código de forma breve en español. Archivo: ${f.path}
Código:
${f.content.slice(0, 1200)}

Responde SOLO con JSON (sin markdown, sin comillas triples):
{"resumen": "una oración", "exportaciones": ["funciones o clases principales"], "notas": "notas importantes si las hay"}`;
        try {
          const raw = await callClaude(prompt);
          return { path: f.path, ...JSON.parse(raw.replace(/```json|```/g, '').trim()) };
        } catch {
          return { path: f.path, resumen: 'No se pudo procesar la documentación.', exportaciones: [], notas: '' };
        }
      })
    );

    hideStatus();
    renderOutput(repoData, resumen, files.filter(f => f.type === 'blob').slice(0, 30), docsArchivos);

  } catch (err) {
    setStatus('Error: ' + err.message, true);
    console.error(err);
  }

  btn.disabled = false;
}

function renderOutput(repo, resumen, todosArchivos, docsArchivos) {
  const area = document.getElementById('outputArea');
  area.className = 'output-area visible';

  const tecnologiasBadges = (resumen.tecnologias || []).map(t =>
    `<span class="badge lang">${t}</span>`).join('');

  const arbolArchivos = todosArchivos.slice(0, 25).map(f => {
    const parts = f.path.split('/');
    const nombre = parts[parts.length - 1];
    const indent = parts.length > 1 ? '  '.repeat(parts.length - 1) : '';
    const docEntry = docsArchivos.find(d => d.path === f.path);
    const nota = docEntry ? `<span class="file-doc">// ${docEntry.resumen}</span>` : '';
    return `<div class="file">${indent}${nombre}${nota}</div>`;
  }).join('');

  const tarjetasArchivos = docsArchivos.map(f => `
    <div class="file-card">
      <div class="file-card-name">${f.path}</div>
      <div class="file-card-desc">${f.resumen}${f.notas ? '<br/><br/><em>' + f.notas + '</em>' : ''}</div>
      ${f.exportaciones?.length ? `<div style="margin-top:10px;">${f.exportaciones.map(e => `<span class="badge">${e}</span>`).join(' ')}</div>` : ''}
    </div>
  `).join('');

  const textoDoc = `# ${repo.full_name}\n\n## Descripción\n${resumen.descripcion}\n\n## Propósito\n${resumen.proposito}\n\n## Tecnologías\n${(resumen.tecnologias||[]).join(', ')}\n\n## Instalación\n${resumen.instalacion}\n\n## Estructura\n${resumen.estructura}\n\n## Archivos\n${docsArchivos.map(f=>`### ${f.path}\n${f.resumen}\n${f.notas||''}`).join('\n\n')}`;

  area.innerHTML = `
    <div class="repo-meta">
      <div>
        <div class="repo-name">${repo.full_name}</div>
        <div class="repo-badges">
          ${tecnologiasBadges}
          <span class="badge">★ ${repo.stargazers_count}</span>
          <span class="badge">${repo.default_branch}</span>
          ${repo.license ? `<span class="badge">${repo.license.spdx_id}</span>` : ''}
        </div>
      </div>
      <button class="copy-btn" onclick="copiarDoc(\`${textoDoc.replace(/`/g,'\\`')}\`)">Copiar como Markdown</button>
    </div>

    <div class="doc-section">
      <div class="doc-section-title">Descripción general</div>
      <div class="doc-content"><p>${resumen.descripcion}</p></div>
    </div>

    <div class="doc-section">
      <div class="doc-section-title">Propósito</div>
      <div class="doc-content"><p>${resumen.proposito}</p></div>
    </div>

    <div class="doc-section">
      <div class="doc-section-title">Instalación</div>
      <div class="doc-content"><p>${resumen.instalacion}</p></div>
    </div>

    <div class="doc-section">
      <div class="doc-section-title">Estructura del proyecto</div>
      <div class="doc-content"><p>${resumen.estructura}</p></div>
    </div>

    <div class="doc-section">
      <div class="doc-section-title">Árbol de archivos</div>
      <div class="file-tree">${arbolArchivos}</div>
    </div>

    <div class="doc-section">
      <div class="doc-section-title">Documentación por archivo</div>
      <div class="file-cards">${tarjetasArchivos}</div>
    </div>
  `;
}

function copiarDoc(texto) {
  navigator.clipboard.writeText(texto).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'Copiado ✓';
    setTimeout(() => btn.textContent = 'Copiar como Markdown', 2000);
  });
}
