(()=>{
  const key='branch-review:appearance';
  let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{}
  let theme=['dark','tesseract'].includes(saved.theme)?'dark':'classic';
  function apply(){document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--accent',theme==='dark'?'#8ab4f8':'#244e40');document.documentElement.style.setProperty('--accent-ink',theme==='dark'?'#101020':'#ffffff');const button=document.getElementById('theme-toggle');if(button){const label=theme==='dark'?'Switch to light mode':'Switch to dark mode';button.setAttribute('aria-label',label);button.title=label;}}
  apply();document.addEventListener('DOMContentLoaded',()=>{const button=document.getElementById('theme-toggle');apply();button.addEventListener('click',()=>{theme=theme==='dark'?'classic':'dark';apply();try{localStorage.setItem(key,JSON.stringify({theme}));}catch{}});});
})();
