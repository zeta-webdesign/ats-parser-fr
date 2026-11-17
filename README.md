# ats-parser-fr

Lecteur de CV PDF façon ATS, pour les CV français. Il extrait ce qu'un logiciel de recrutement lit : nom, email, téléphone, ville, rubriques, postes avec leurs dates, formations, compétences.

Portage en JavaScript navigateur du lecteur d'[OpenResume](https://github.com/xitanggg/open-resume) (Xitang Zhao), adapté aux CV français : titres de rubriques, mois, numéros de téléphone, codes postaux, intitulés de postes, écoles et diplômes, mots-clés sans accents.

Utilisé par 1jobpourtoi by CodeBreak.

## Utilisation

```html
<script src="ats-parser.js"></script>
<script type="module">
  import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.min.mjs";
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.worker.min.mjs";
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  const resume = await window.parseResumePdf(pdf);
  // { text, columns, edges, sections, profile, workExperiences, educations, skills }
</script>
```

Testé avec PDF.js 6.5. Gardez PDF.js à jour : les versions 4.1 et antérieures ont une faille connue (CVE-2024-4367).

Tout se passe dans le navigateur : le fichier n'est envoyé nulle part.

## Licence

AGPL-3.0, comme OpenResume dont il dérive (voir `LICENSE`).
