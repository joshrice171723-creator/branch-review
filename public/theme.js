(()=>{
const key='branch-review:appearance',defaults={classic:'#244e40',tesseract:'#c49aff'};
let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{}
let theme=saved.theme==='tesseract'?'tesseract':'classic',accent=/^#[0-9a-f]{6}$/i.test(saved.accent)?saved.accent:defaults[theme];
function apply(){const root=document.documentElement;root.dataset.theme=theme;root.style.setProperty('--accent',accent);const rgb=accent.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);root.style.setProperty('--accent-ink',rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#101020':'#ffffff');}
apply();document.addEventListener('DOMContentLoaded',()=>{const style=document.getElementById('theme-style'),color=document.getElementById('theme-accent'),status=document.getElementById('theme-status');function save(){apply();style.value=theme;color.value=accent;try{localStorage.setItem(key,JSON.stringify({theme,accent}));status.textContent='Saved automatically on this device.';}catch{status.textContent='Applied for this session; could not save preference.';}}style.value=theme;color.value=accent;style.onchange=()=>{theme=style.value;accent=defaults[theme];save();};color.oninput=()=>{accent=color.value;save();};document.getElementById('theme-reset').onclick=()=>{accent=defaults[theme];save();};});
})();
