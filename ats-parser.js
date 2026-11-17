// ATS-style resume parser, ported from OpenResume (https://github.com/xitanggg/open-resume,
// src/app/lib/parse-resume-from-pdf) — Copyright (c) Xitang Zhao, AGPL-3.0, see LICENSE.
// Changes: plain browser JS taking a PDF.js document (tested with PDF.js 6), French resumes (section titles, months,
// phone numbers, postcodes, job titles, schools, degrees), accent-insensitive keyword matching.
// Same 4 steps: PDF text items -> lines -> sections -> feature-scoring extraction.
(() => {
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

  // ---------- Step 1: read the PDF into positioned text items ----------
  async function readPdf(pdf) {
    let items = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      await page.getOperatorList() // loads font data so commonObjs knows the real font names
      const start = items.length
      for (const it of content.items) {
        let fontName = it.fontName
        try { fontName = page.commonObjs.get(it.fontName)?.name ?? fontName } catch {}
        items.push({ page: i, ph: page.view[3] - page.view[1], text: it.str.replace(/-­‐/g, '-'), x: it.transform[4], y: it.transform[5], width: it.width, height: it.height, fontName, hasEOL: it.hasEOL })
      }
      if (items.length > start) items.at(-1).hasEOL = true // a page never continues the previous one's last line
    }
    return items.filter(t => t.hasEOL || t.text.trim() !== '')
  }

  // ---------- Step 2: group text items into lines ----------
  const BULLET_POINTS = ['⋅', '∙', '🞄', '•', '⦁', '⚫︎', '●', '⬤', '⚬', '○', '▪', '■', '◦', '➢', '➤', '►', '✓', '✔']
  function groupTextItemsIntoLines(items) {
    const lines = []; let line = []
    for (const item of items) {
      if (item.hasEOL) { if (item.text.trim() !== '') line.push({ ...item }); lines.push(line); line = [] }
      else if (item.text.trim() !== '') {
        const prev = line.at(-1) // items far apart vertically are not one line, even without an EOL between them
        if (prev && Math.abs(prev.y - item.y) > Math.min(prev.height, item.height) * 0.6) { lines.push(line); line = [] }
        line.push({ ...item })
      }
    }
    if (line.length) lines.push(line)
    const charWidth = typicalCharWidth(lines.flat())
    for (const l of lines) {
      for (let i = l.length - 1; i > 0; i--) {
        const cur = l[i], left = l[i - 1]
        if (cur.x - (left.x + left.width) <= charWidth) {
          if (shouldAddSpace(left.text, cur.text) || (cur.x - (left.x + left.width) > charWidth * 0.2 && !left.text.endsWith(' ') && !cur.text.startsWith(' '))) left.text += ' '
          left.text += cur.text
          left.width = cur.x + cur.width - left.x
          l.splice(i, 1)
        }
      }
    }
    return lines.filter(l => l.length && !/^page ?\d+ ?(?:of|sur|de|\/) ?\d+$/i.test(l.map(i => i.text).join(' ').trim())) // page footer
  }

  // Multi-column layouts (LinkedIn export, Canva sidebars): like commercial parsers, read each column on its own.
  // Gutter = an x no item crosses, with a section title on both sides (so right-aligned dates are not a column).
  function splitColumns(lines) {
    const pages = [], chars = [0, 0], tallest = [0, 0]
    for (const p of [...new Set(lines.map(l => l[0].page))]) {
      const ls = lines.filter(l => l[0].page === p), items = ls.flat()
      const gutter = [...new Set(items.map(i => i.x))].sort((a, b) => a - b).slice(1).find(g => items.every(i => i.x >= g || i.x + i.width <= g)
        && [ls.filter(l => l[0].x < g), ls.filter(l => l[0].x >= g)].every(side => side.some(looksLikeTitle)))
      if (gutter === undefined) { pages.push(ls); continue }
      const cols = [0, 1].map(side => ls.map(l => l.filter(i => (i.x >= gutter) === !!side)).filter(l => l.length).sort((a, b) => b[0].y - a[0].y)) // reading order: top to bottom
      cols.forEach((c, side) => { const it = c.flat(); it.forEach(i => { i.col = side }); chars[side] += it.reduce((n, i) => n + i.text.length, 0); tallest[side] = Math.max(tallest[side], ...it.map(i => i.height)) })
      pages.push(cols)
    }
    if (pages.every(p => !Array.isArray(p[0]?.[0]))) return lines
    const main = chars[1] > chars[0] ? 1 : 0, side = 1 - main // pages without a sidebar continue the main column
    const mainStream = pages.flatMap(p => Array.isArray(p[0]?.[0]) ? p[main] : p), sideStream = pages.flatMap(p => Array.isArray(p[0]?.[0]) ? p[side] : [])
    return tallest[main] >= tallest[side] ? [...mainStream, ...sideStream] : [...sideStream, ...mainStream] // column holding the name (largest font) first
  }
  const shouldAddSpace = (l, r) => ([':', ',', '|', '.', ...BULLET_POINTS].includes(l.at(-1)) && r[0] !== ' ') || (l.at(-1) !== ' ' && ['|', ...BULLET_POINTS].includes(r[0]))
  function typicalCharWidth(items) {
    items = items.filter(i => i.text.trim() !== '')
    const hc = {}, fc = {}; let h = 0, hMax = 0, f = '', fMax = 0
    for (const { text, height, fontName } of items) {
      hc[height] = (hc[height] ?? 0) + 1; if (hc[height] > hMax) { h = height; hMax = hc[height] }
      fc[fontName] = (fc[fontName] ?? 0) + text.length; if (fc[fontName] > fMax) { f = fontName; fMax = fc[fontName] }
    }
    const common = items.filter(i => i.fontName === f && i.height === h)
    const [w, n] = common.reduce(([w, n], c) => [w + c.width, n + c.text.length], [0, 0])
    return n ? w / n : 0
  }

  // ---------- common features ----------
  const isBold = item => /bold|black|heavy|semibold/i.test(item?.fontName ?? '')
  const hasLetter = item => /\p{L}/u.test(item.text)
  const hasNumber = item => /[0-9]/.test(item.text)
  const hasComma = item => item.text.includes(',')
  const getHasText = text => item => !!text && item.text.includes(text)
  const hasOnlyLettersSpacesAmpersands = item => /^[\p{L}\s&'’-]+$/u.test(item.text)
  const hasLetterAndIsAllUpperCase = item => hasLetter(item) && item.text.toUpperCase() === item.text
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
  const hasYear = item => /(?:19|20)\d{2}/.test(item.text)
  const hasMonth = item => { const t = norm(item.text); return MONTHS.some(m => t.includes(norm(m)) || t.includes(norm(m).slice(0, 4))) }
  const hasSeason = item => /summer|fall|spring|winter|ete|automne|printemps|hiver/.test(norm(item.text))
  const hasPresent = item => /present|aujourd'?hui|a ce jour|en cours|actuel|now/.test(norm(item.text))
  const DATE_FEATURE_SETS = [[hasYear, 1], [hasMonth, 1], [hasSeason, 1], [hasPresent, 1], [hasComma, -1]]

  // ---------- Step 3: group lines into sections ----------
  // English keywords from OpenResume + French equivalents (compared without accents)
  const SECTION_TITLE_KEYWORDS = ['experience', 'education', 'project', 'skill', 'job', 'course', 'extracurricular', 'objective', 'summary', 'award', 'honor',
    'parcours', 'emploi', 'stage', 'formation', 'diplome', 'etudes', 'scolarite', 'projet', 'competence', 'savoir', 'qualites', 'atouts', 'profil', 'resume',
    'objectif', 'a propos', 'langue', 'language', 'interet', 'loisir', 'certification', 'benevolat', 'informations', 'contact', 'coordonnees', 'publication', 'distinction']
  function looksLikeTitle(line) {
    if (line.length !== 1) return false
    const item = line[0], text = item.text.trim()
    return text.split(' ').filter(s => s !== '&').length <= 3 && hasOnlyLettersSpacesAmpersands(item) && /^\p{Lu}/u.test(text)
      && SECTION_TITLE_KEYWORDS.some(k => norm(text).includes(k))
  }
  // Typographic hierarchy: when a CV sets its section titles in a larger font (LinkedIn 13-16pt, Canva 17pt vs 10.5-11pt body),
  // the title size of each column is the most frequent height among keyword titles; smaller lines are entries
  // ("VENDEUSE EN SHOWROOM", "Gestion de projet"), not sections. Returns col -> minimum title height.
  function titleMinHeight(lines) {
    const byH = {}; for (const i of lines.flat()) byH[i.height] = (byH[i.height] ?? 0) + i.text.length
    const body = +Object.entries(byH).sort((a, b) => b[1] - a[1])[0]?.[0] || 0
    const sized = lines.filter(l => looksLikeTitle(l) && l[0].height >= body * 1.15)
    if (sized.length < 2) return () => 0
    const perCol = {}
    for (const l of sized) { const c = perCol[l[0].col] ??= {}; c[l[0].height] = (c[l[0].height] ?? 0) + 1 }
    return col => { const c = Object.entries(perCol[col] ?? {}).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]; return c ? c[0] * 0.95 : body * 1.15 }
  }
  function isSectionTitle(line, n, minH) {
    if (n < 2 || line.length !== 1 || line[0].height < minH(line[0].col)) return false
    return (isBold(line[0]) && hasLetterAndIsAllUpperCase(line[0])) || looksLikeTitle(line)
  }
  function groupLinesIntoSections(lines) {
    const sections = {}, minH = titleMinHeight(lines); let name = 'profile', current = []
    lines.forEach((line, i) => {
      if (isSectionTitle(line, i, minH)) { sections[name] = [...current]; name = line[0].text.trim(); current = [] }
      else current.push(line)
    })
    if (current.length) sections[name] = [...current]
    return sections
  }
  const sectionLines = (sections, keywords) => {
    for (const name in sections) if (name !== 'profile' && keywords.some(k => norm(name).includes(k))) return sections[name]
    return []
  }

  // ---------- feature scoring system ----------
  function scores(items, featureSets) {
    const out = items.map(i => ({ text: i.text, score: 0, match: false }))
    items.forEach((item, i) => {
      for (const [has, score, onlyMatch] of featureSets) {
        const r = has(item); if (!r) continue
        const text = onlyMatch && typeof r === 'object' ? r[0] : item.text
        if (item.text === text) { out[i].score += score; if (onlyMatch) out[i].match = true }
        else out.push({ text, score, match: true })
      }
    })
    return out
  }
  function best(items, featureSets, emptyIfNotPositive = true, concatTies = false) {
    let top = [], high = -Infinity
    for (const { text, score } of scores(items, featureSets)) {
      if (score >= high) { if (score > high) top = []; top.push(text); high = score }
    }
    if (emptyIfNotPositive && high <= 0) return ''
    return concatTies ? top.map(s => s.trim()).join(' ') : top[0] ?? ''
  }

  // ---------- subsections & bullet points ----------
  function subsections(lines) {
    const ys = lines.map(l => l[0].y), gaps = {}; let common = 0, max = 0
    for (let i = 1; i < ys.length; i++) { const g = Math.round(ys[i - 1] - ys[i]); gaps[g] = (gaps[g] ?? 0) + 1; if (gaps[g] > max) { common = g; max = gaps[g] } }
    const split = isNew => { const out = []; let cur = []
      lines.forEach((l, i) => { if (i && isNew(l, lines[i - 1])) { out.push(cur); cur = [] } cur.push(l) })
      if (cur.length) out.push(cur); return out }
    let subs = split((l, p) => Math.round(p[0].y - l[0].y) > common * 1.4 || (l[0].page !== p[0].page && l[0].height > p[0].height)) // new page opening on an entry heading
    if (subs.length === 1) subs = split((l, p) => !isBold(p[0]) && isBold(l[0]) && !BULLET_POINTS.includes(l[0].text))
    return subs
  }
  const firstBulletIdx = lines => { for (let i = 0; i < lines.length; i++) if (lines[i].some(it => BULLET_POINTS.some(b => it.text.includes(b)))) return i }
  function descriptionsIdx(lines) {
    let idx = firstBulletIdx(lines)
    if (idx === undefined) idx = lines.findIndex(l => l.length === 1 && l[0].text.split(/\s/).filter(w => /^[^0-9]+$/.test(w)).length >= 8)
    return idx === -1 ? undefined : idx
  }
  function bullets(lines) {
    if (firstBulletIdx(lines) === undefined) return lines.map(l => l.map(i => i.text).join(' ')).filter(Boolean)
    let str = ''
    for (const it of lines.flat()) { if (!str.endsWith(' ') && !it.text.startsWith(' ')) str += ' '; str += it.text }
    const counts = {}; let bullet = BULLET_POINTS[0], max = 0
    for (const ch of str) if (BULLET_POINTS.includes(ch)) { counts[ch] = (counts[ch] ?? 0) + 1; if (counts[ch] > max) { bullet = ch; max = counts[ch] } }
    const start = str.indexOf(bullet); if (start !== -1) str = str.slice(start)
    return str.split(bullet).map(t => t.trim()).filter(Boolean)
  }

  // ---------- Step 4: extract the resume ----------
  const matchName = item => item.text.match(/^[\p{L}\s.'’-]+$/u)
  const matchEmail = item => item.text.match(/\S+@\S+\.\S+/)
  const hasAt = item => item.text.includes('@')
  const matchPhone = item => item.text.match(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}|\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/)
  const hasParenthesis = item => /\([0-9]+\)/.test(item.text)
  const matchLocation = item => item.text.match(/\b\d{5}\s+\p{Lu}[\p{L}' -]+|\p{Lu}[\p{L}'’ -]+(?:, \p{Lu}[\p{L}'’ -]+)*, (?:[A-Z]{2}\b|France)/u)
  const matchUrl = item => item.text.match(/\S+\.[a-z]+\/\S+/)
  const matchUrlHttp = item => item.text.match(/https?:\/\/\S+\.\S+/)
  const matchUrlWww = item => item.text.match(/www\.\S+\.\S+/)
  const hasSlash = item => item.text.includes('/')
  const has4OrMoreWords = item => item.text.split(' ').length >= 4

  function extractProfile(sections) {
    const items = [...(sections.profile ?? []), ...sectionLines(sections, ['contact', 'coordonnees'])].flat()
    const maxH = Math.max(0, ...items.map(i => i.height)), isLargest = i => i.height === maxH
    const summarySection = sectionLines(sections, ['summary', 'profil', 'resume', 'a propos']).flat().map(i => i.text).join(' ')
    const objectiveSection = sectionLines(sections, ['objective', 'objectif']).flat().map(i => i.text).join(' ')
    return {
      name: best(items, [[matchName, 3, true], [isLargest, 2], [isBold, 2], [hasLetterAndIsAllUpperCase, 2], [hasAt, -4], [hasNumber, -4], [hasParenthesis, -4], [hasComma, -4], [hasSlash, -4], [has4OrMoreWords, -2]]),
      email: best(items, [[matchEmail, 4, true], [isBold, -1], [hasLetterAndIsAllUpperCase, -1], [hasParenthesis, -4], [hasComma, -4], [hasSlash, -4], [has4OrMoreWords, -4]]),
      phone: best(items, [[matchPhone, 4, true], [hasLetter, -4]]),
      location: best(items, [[matchLocation, 4, true], [isBold, -1], [hasAt, -4], [hasParenthesis, -3], [hasSlash, -4]]),
      url: best(items, [[matchUrl, 4, true], [matchUrlHttp, 3, true], [matchUrlWww, 3, true], [isBold, -1], [hasAt, -4], [hasParenthesis, -3], [hasComma, -4], [has4OrMoreWords, -4]]),
      summary: summarySection || objectiveSection || best(items, [[has4OrMoreWords, 4], [isBold, -1], [hasAt, -4], [hasParenthesis, -3], [matchLocation, -4, false]], undefined, true),
    }
  }

  const SCHOOLS = ['College', 'University', 'Institute', 'School', 'Academy', 'Université', 'Universite', 'École', 'Ecole', 'Lycée', 'Lycee', 'Collège', 'Institut', 'IUT', 'IAE', 'CFA', 'Faculté', 'Académie', 'GRETA', 'AFPA', 'Campus']
  const DEGREES = ['Associate', 'Bachelor', 'Master', 'PhD', 'Ph.', 'Licence', 'Mastère', 'Bac', 'BTS', 'DUT', 'BUT', 'CAP', 'BEP', 'Doctorat', 'Diplôme', 'Titre professionnel', 'MBA', 'DEUG', 'DAEU', 'Brevet', 'Certificat', 'Certificate']
  // dictionaries also match all-caps headings ("LICENCE", "VENDEUSE"), as whole words only ("BUT" yes, "début" no)
  const inCaps = (item, words) => hasLetterAndIsAllUpperCase(item) && words.some(w => new RegExp(`(?:^|[^\\p{L}])${w.toUpperCase().replace('.', '\\.')}(?:$|[^\\p{L}])`, 'u').test(item.text))
  const hasSchool = item => SCHOOLS.some(s => item.text.includes(s)) || inCaps(item, SCHOOLS)
  const hasDegree = item => DEGREES.some(d => item.text.includes(d)) || inCaps(item, DEGREES) || /\b(?:[ABM]\.?[AS]c?|MSc|BSc)\b/.test(item.text)
  function extractEducation(sections) {
    return subsections(sectionLines(sections, ['education', 'formation', 'diplome', 'etudes', 'scolarite'])).map(lines => {
      const items = lines.flat(), idx = descriptionsIdx(lines), isFirst = i => i === items[0]
      return {
        school: best(items, [[hasSchool, 4], [isFirst, 1], [hasDegree, -4], [hasNumber, -2]]), // "Université Lyon II - 2012"
        degree: best(items, [[hasDegree, 4], [hasSchool, -4], [hasNumber, -3]]),
        date: best(items, DATE_FEATURE_SETS),
        descriptions: idx === undefined ? [] : bullets(lines.slice(idx)),
      }
    })
  }

  const JOB_TITLES = ['Accountant', 'Administrator', 'Advisor', 'Agent', 'Analyst', 'Apprentice', 'Assistant', 'Associate', 'Buyer', 'Cashier', 'Clerk', 'Consultant', 'Coordinator', 'Designer', 'Director', 'Driver', 'Editor', 'Founder', 'Head', 'Intern', 'Lead', 'Manager', 'Member', 'Nurse', 'Officer', 'Operator', 'President', 'Recruiter', 'Representative', 'Sales', 'Server', 'Specialist', 'Supervisor', 'Teacher', 'Technician', 'Trainee', 'Volunteer', 'Worker',
    'Vendeur', 'Vendeuse', 'Assistante', 'Responsable', 'Chargé', 'Chargée', 'Conseiller', 'Conseillère', 'Directeur', 'Directrice', 'Chef', 'Employé', 'Employée', 'Technicien', 'Technicienne', 'Ingénieur', 'Ingénieure', 'Stagiaire', 'Stage', 'Commercial', 'Commerciale', 'Gestionnaire', 'Hôte', 'Hôtesse', 'Serveur', 'Serveuse', 'Caissier', 'Caissière', 'Comptable', 'Secrétaire', 'Infirmier', 'Infirmière', 'Animateur', 'Animatrice', 'Coordinateur', 'Coordinatrice', 'Consultante', 'Opérateur', 'Opératrice', 'Préparateur', 'Préparatrice', 'Réceptionniste', 'Alternant', 'Alternante', 'Apprenti', 'Apprentie', 'Équipier', 'Équipière', 'Formateur', 'Formatrice', 'Agente', 'Adjoint', 'Adjointe', 'Gérant', 'Gérante', 'Cuisinier', 'Cuisinière', 'Barman', 'Livreur', 'Livreuse', 'Magasinier', 'Magasinière', 'Aide', 'Auxiliaire', 'Bénévole']
  const hasJobTitle = item => item.text.split(/\s/).some(w => JOB_TITLES.includes(w.replace(/[,.:;]$/, ''))) || inCaps(item, JOB_TITLES)
  function extractWork(sections) {
    return subsections(sectionLines(sections, ['work', 'experience', 'employment', 'history', 'job', 'parcours', 'emploi', 'stage'])).map(lines => {
      let idx = descriptionsIdx(lines)
      if (idx === undefined) { idx = 2; while (idx < Math.min(lines.length, 5) && lines[idx].some(i => hasYear(i) || matchLocation(i))) idx++ }
      const info = lines.slice(0, idx).flat()
      const date = best(info, DATE_FEATURE_SETS)
      const jobTitle = best(info, [[hasJobTitle, 4], [hasNumber, -4], [item => item.text.split(/\s/).length > 5, -2]])
      const company = best(info, [[isBold, 2], [getHasText(date), -4], [getHasText(jobTitle), -4]], false)
      return { company, jobTitle, date, descriptions: bullets(lines.slice(idx)) }
    })
  }

  function extractSkills(sections) {
    const lines = sectionLines(sections, ['skill', 'competence', 'savoir', 'qualites', 'atouts'])
    const idx = descriptionsIdx(lines) ?? 0
    const featured = idx ? lines.slice(0, idx).flat().map(i => i.text.trim()).filter(Boolean).slice(0, 6) : []
    return [...featured, ...bullets(lines.slice(idx))]
  }

  // Public API: pdf = a pdf.js document. Returns what an ATS would extract + the detected section titles.
  // Lines sitting in a page's header or footer zone: the outer 3.5 % of the page, or the same line at the same
  // height on two pages (a repeated header or footer). Several ATS skip those zones (Greenhouse lists it as a parse failure).
  function edgeLines(lines) {
    const seen = new Map(), out = new Set()
    for (const l of lines) {
      const text = l.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(), y = l[0].y, ph = l[0].ph || 842
      if (!text) continue
      if (y < ph * 0.035 || y > ph * 0.965) out.add(text)
      const key = `${text}|${Math.round(y)}`
      if (seen.has(key) && seen.get(key) !== l[0].page) out.add(text)
      seen.set(key, l[0].page)
    }
    return [...out].slice(0, 20)
  }

  window.parseResumePdf = async pdf => {
    const raw = groupTextItemsIntoLines(await readPdf(pdf)), lines = splitColumns(raw)
    const sections = groupLinesIntoSections(lines)
    return {
      text: lines.map(l => l.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim()).join('\n'), // column-aware reading order
      columns: lines.flat().some(i => i.col !== undefined),
      edges: edgeLines(raw),
      sections: Object.keys(sections).filter(s => s !== 'profile'),
      profile: extractProfile(sections),
      workExperiences: extractWork(sections),
      educations: extractEducation(sections),
      skills: extractSkills(sections),
    }
  }
})()
