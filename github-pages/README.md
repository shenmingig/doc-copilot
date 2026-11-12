# Doc Copilot GitHub Pages Site

This folder is a static GitHub Pages site for Doc Copilot.

## Publish with GitHub Pages

1. Create a public GitHub repository, for example `doc-copilot-site`.
2. Upload every file in this folder to the repository root.
3. Open the repository on GitHub.
4. Go to `Settings` -> `Pages`.
5. Set `Source` to `Deploy from a branch`.
6. Set `Branch` to `main` and folder to `/ (root)`.
7. Save and wait for GitHub Pages to publish.

The privacy policy URL will look like:

```text
https://YOUR_GITHUB_USERNAME.github.io/doc-copilot-site/privacy-policy.html
```

Put that URL in the Chrome Web Store Developer Dashboard:

```text
Doc Copilot -> Privacy -> Privacy Policy
```

Do not put the privacy policy URL only in the product description. Chrome Web
Store requires it in the dedicated privacy policy field.

## Optional command-line publish flow

If you have `git` and a GitHub repository ready:

```bash
cd /Users/gongyanqing/Desktop/workspace/baidu/mint/doc-copilot/github-pages
git init
git branch -M main
git add .
git commit -m "Add Doc Copilot privacy policy"
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/doc-copilot-site.git
git push -u origin main
```

Then enable GitHub Pages from the repository's `Settings` -> `Pages` page.

