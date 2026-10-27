// Assemble the static GitHub Pages site without exposing server-side code.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
function buildPages(projectRoot=path.resolve(__dirname,'..')) {
  const output=path.join(projectRoot,'dist');
  fs.rmSync(output,{recursive:true,force:true});
  fs.mkdirSync(path.join(output,'shared'),{recursive:true});
  for(const file of ['index.html','style.css','client.js','favicon.svg','favicon.ico','apple-touch-icon.png'])
    fs.copyFileSync(path.join(projectRoot,'public',file),path.join(output,file));
  for(const file of ['tiles.js','rules.js','game.js'])
    fs.copyFileSync(path.join(projectRoot,'shared',file),path.join(output,'shared',file));
  // Source HTML lives at public/ locally; Pages serves it from its site root.
  const pageFile=path.join(output,'index.html');
  const source=fs.readFileSync(pageFile,'utf8');
  if(!source.includes('../shared/'))throw Error('Expected shared-script paths were not found.');
  fs.writeFileSync(pageFile,source.replaceAll('../shared/','shared/'));
  return output;
}
if(require.main===module)console.log(`GitHub Pages files written to ${buildPages()}`);
module.exports={buildPages};
