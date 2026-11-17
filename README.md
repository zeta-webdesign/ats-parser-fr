# ats-parser-fr

Lecteur de CV PDF façon ATS, pour les CV français. Il extrait ce qu'un logiciel de recrutement lit : nom, email, téléphone, ville, rubriques, postes avec leurs dates, formations, compétences.

Portage en JavaScript navigateur du lecteur d'[OpenResume](https://github.com/xitanggg/open-resume) (Xitang Zhao), adapté aux CV français : titres de rubriques, mois, numéros de téléphone, codes postaux, intitulés de postes, écoles et diplômes, mots-clés sans accents.

Utilisé par 1jobpourtoi by CodeBreak.

## Utilisation

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="ats-parser.js"></script>
<script>
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const resume = await window.parseResumePdf(pdf);
  // { text, columns, edges, sections, profile, workExperiences, educations, skills }
</script>
```

Tout se passe dans le navigateur : le fichier n'est envoyé nulle part.

## Licence

AGPL-3.0, comme OpenResume dont il dérive (voir `LICENSE`).
