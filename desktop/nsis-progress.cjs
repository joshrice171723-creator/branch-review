const fs = require('node:fs');
const path = require('node:path');
const nsis = require('app-builder-lib/out/targets/nsis/nsisUtil');

const stage = process.env.BRANCH_REVIEW_NSIS_TEMPLATE_STAGE;
if (!stage || !path.isAbsolute(stage)) throw Error('Set the installer template stage to an absolute path.');

function patch(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.split(before).length !== 2) throw Error('Unexpected Electron Builder template: ' + file);
  fs.writeFileSync(file, source.replace(before, () => after), 'utf8');
}

// Use a private copy so Electron Builder still builds its stock uninstaller.
fs.mkdirSync(stage);
fs.cpSync(nsis.nsisTemplatesDir, stage, {recursive: true});
fs.copyFileSync(path.join(__dirname, 'nsis-progress.nsh'), path.join(stage, 'include', 'branchReviewProgress.nsh'));

const script = path.join(stage, 'installer.nsi');
const init = 'Function .onInit';
patch(script, init, init + '\n  !ifndef BUILD_UNINSTALLER\n    Call BranchReviewInitProgress\n  !endif');
const installUtil = '  !include "installUtil.nsh"';
patch(script, installUtil, installUtil + '\n  !include "branchReviewProgress.nsh"');

const extractor = path.join(stage, 'include', 'extractAppPackage.nsh');
const extract = '  Nsis7z::Extract "${FILE}"';
const prepare = '  SetOutPath "$PLUGINSDIR\\7z-out"';
patch(extractor, prepare + '\n' + extract, prepare + '\n  !insertmacro BranchReviewExtract "${FILE}"');
const stockApply = fs.readFileSync(extractor, 'utf8').match(/  # Retry counter\n[\s\S]*?  DoneExtract7za:\n/);
if (!stockApply?.[0].includes('CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR')) {
  throw Error('Unexpected Electron Builder template: ' + extractor);
}
patch(extractor, stockApply[0], '  Call BranchReviewApplyFiles\n');

nsis.nsisTemplatesDir = stage;
