/**
 * Navigateur headless des sessions, lancé au premier usage.
 *
 * Avant, chaque session d'un projet avec l'option « navigateur » démarrait son Chromium (6 processus, ~350 Mo
 * avec playwright-mcp) dès son lancement, même si l'agent ne s'en servait jamais. Or `playwright-mcp` ne se
 * connecte à son `--cdp-endpoint` qu'au premier appel d'un outil du navigateur (initialize et tools/list n'y
 * touchent pas). Le serveur MCP donné au CLI est donc ce relais (`node -e`, dans le conteneur du projet) :
 *
 * - il réserve un port local (qu'il garde ouvert toute sa vie, sans course avec un autre processus) et lance
 *   `playwright-mcp --cdp-endpoint http://127.0.0.1:<port>` en lui passant ses entrées-sorties (stdio MCP) ;
 * - à la première connexion sur ce port (premier outil du navigateur), il lance Chromium (script START_CHROMIUM,
 *   dans le dossier de la session, détaché comme avant), attend son port CDP (`DevToolsActivePort`), puis relaie
 *   chaque connexion TCP vers lui ;
 * - si Chromium s'arrête (plantage, mémoire), la connexion suivante le relance.
 *
 * Le backend (vue en direct, saisie du coffre, arrêt) retrouve Chromium par le même dossier : `chromium.pid` et
 * `profile/DevToolsActivePort`.
 *
 * Arguments du relais : dossier de la session, script de lancement de Chromium, puis ceux de playwright-mcp.
 */
export const LAZY_BROWSER_MCP = `const net=require('net'),fs=require('fs'),{spawn}=require('child_process');
const [dir,start,...mcpArgs]=process.argv.slice(1);
const portFile=dir+'/profile/DevToolsActivePort';
const readPort=()=>{try{const l=fs.readFileSync(portFile,'utf8').split('\\n');return l[1]?Number(l[0]):0}catch{return 0}};
let ready=null;
const launch=()=>new Promise((resolve,reject)=>{
  const c=spawn('sh',['-c',start,'sh',dir],{detached:true,stdio:'ignore'});c.unref();
  let exited=false;c.on('exit',()=>{exited=true;ready=null;try{fs.unlinkSync(portFile)}catch{}});
  let i=0;const t=setInterval(()=>{const p=readPort();if(p){clearInterval(t);resolve(p)}else if(exited||++i>150){clearInterval(t);reject(new Error('Chromium n\\'a pas démarré (journal : '+dir+'/chromium.log)'))}},100);
});
const browser=()=>{if(!ready){ready=launch();ready.catch((e)=>{ready=null;process.stderr.write('[skipper] '+e.message+'\\n')})}return ready};
const server=net.createServer((sock)=>{
  sock.pause();sock.on('error',()=>{});
  browser().then((port)=>{
    const up=net.connect(port,'127.0.0.1');
    up.on('connect',()=>{sock.pipe(up);up.pipe(sock)});
    up.on('error',()=>sock.destroy());sock.on('close',()=>up.destroy());up.on('close',()=>sock.destroy());
  },()=>sock.destroy());
});
server.listen(0,'127.0.0.1',()=>{
  const child=spawn('playwright-mcp',['--cdp-endpoint','http://127.0.0.1:'+server.address().port,...mcpArgs],{stdio:'inherit'});
  child.on('exit',(code)=>process.exit(code??1));
  child.on('error',(e)=>{process.stderr.write('[skipper] playwright-mcp : '+e.message+'\\n');process.exit(1)});
  for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>child.kill(s));
});`;

/**
 * Lancement de Chromium ($1 = dossier de la session). Binaire « headless shell » installé par Playwright
 * (dernière version présente dans l'image). Port CDP choisi par Chromium (`=0`, plusieurs sessions par
 * conteneur), qu'il écrit avec le chemin du point d'accès dans `DevToolsActivePort`. Options reprises de
 * celles de Playwright ; `--disable-dev-shm-usage` : le /dev/shm d'un conteneur ne fait que 64 Mo.
 */
export const START_CHROMIUM = `set -e
mkdir -p "$1/profile"
bin=$(ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1)
if [ -z "$bin" ]; then echo "Chromium introuvable dans l'image (/opt/ms-playwright) : reconstruire skipper-runner" > "$1/chromium.log"; exit 1; fi
echo $$ > "$1/chromium.pid"
exec "$bin" --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-background-networking \\
  --disable-component-update --disable-sync --disable-features=Translate,MediaRouter --mute-audio --hide-scrollbars \\
  --password-store=basic --use-mock-keychain --window-size=1280,800 \\
  --remote-debugging-port=0 --user-data-dir="$1/profile" about:blank > "$1/chromium.log" 2>&1`;

/** Contrôle au lancement de la session, sans démarrer Chromium : le binaire est-il dans l'image ? */
export const FIND_CHROMIUM = `ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1`;

/** Point d'accès CDP lu dans `DevToolsActivePort` (port, puis chemin) ; null tant que Chromium n'a pas démarré. */
export function parseDevToolsActivePort(content: string): { port: number; browserPath: string } | null {
  const [port, browserPath] = content.trim().split('\n');
  if (!/^\d+$/.test(port ?? '') || !browserPath?.startsWith('/devtools/browser/')) return null;
  return { port: Number(port), browserPath: browserPath.trim() };
}
