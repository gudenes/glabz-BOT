/**
 * Navegador de verdade para os testes visuais.
 *
 * Por que existe: os defeitos mais reincidentes desta fase não eram de lógica,
 * eram de TELA — balão do tour tapando o botão que ele explicava, balão
 * aparecendo apagado por trás de um diálogo, painel espremendo o builder,
 * expressão regular crua no cartão. Nenhum teste de lógica pega isso, porque
 * todos dependem de geometria e pintura reais.
 *
 * Usa o Chrome que já está instalado na máquina (puppeteer-core, sem baixar
 * navegador). Sem Chrome, os testes se PULAM em vez de falhar.
 */
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CANDIDATOS = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean) as string[];

export function chromePath(): string | null {
  return CANDIDATOS.find((p) => existsSync(p)) || null;
}

/** Motivo do skip, ou false quando dá pra rodar — no formato do node:test. */
export const skipSemChrome = chromePath()
  ? (false as const)
  : "sem Chrome instalado (defina CHROME_PATH para rodar)";

export async function abrirNavegador(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chromePath() as string,
    headless: true,
    // --no-sandbox é necessário rodando como root em container; é ambiente de
    // teste com conteúdo local, não navegação aberta.
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
}

export type Caixa = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** Geometria real de um elemento, como o navegador pintou. */
export async function caixaDe(page: Page, seletor: string): Promise<Caixa | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, seletor);
}

/** Dois elementos se sobrepõem na tela? */
export function sobrepoe(a: Caixa, b: Caixa): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * O elemento está de fato VISÍVEL pra quem olha?
 *
 * Não basta existir no documento: já tivemos um balão pintado por baixo do
 * fundo escuro de um diálogo — presente, com tamanho, e invisível. Aqui o
 * teste pergunta ao navegador quem está no topo naquele ponto da tela.
 */
export async function visivelDeVerdade(page: Page, seletor: string): Promise<boolean> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const estilo = getComputedStyle(el);
    if (estilo.visibility === "hidden" || estilo.display === "none") return false;
    if (Number(estilo.opacity) < 0.1) return false;
    // Quem o navegador entrega no centro do elemento? Se for outro ramo da
    // árvore, tem alguma coisa por cima.
    const topo = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return Boolean(topo && (el.contains(topo) || topo.contains(el)));
  }, seletor);
}

/**
 * Página em branco já dimensionada, e com armazenamento ISOLADO.
 *
 * O isolamento não é luxo: o portal marca a jornada como vista no
 * localStorage, então dois testes no mesmo contexto se contaminam — o
 * primeiro roda e o segundo não vê balão nenhum. Cada página nasce num
 * contexto próprio, como uma janela anônima.
 *
 * Fechar a página fecha o contexto junto (ver `fecharPagina`).
 */
export async function novaPagina(browser: Browser, largura = 1280, altura = 800): Promise<Page> {
  const contexto = await browser.createBrowserContext();
  const page = await contexto.newPage();
  await page.setViewport({ width: largura, height: altura });
  return page;
}

/**
 * Espera o layout PARAR de mexer antes de medir.
 *
 * Dois quadros de animação não bastam: com mais de um Chrome concorrendo pela
 * CPU, a medição pegava a tela no meio do rearranjo e o teste acusava
 * sobreposição que não existe. Teste instável é pior que teste nenhum — ele
 * ensina a ignorar vermelho.
 *
 * Espera as fontes carregarem (elas mudam as medidas do texto) e o retângulo
 * do alvo repetir duas vezes seguidas.
 */
export async function esperarLayoutEstavel(page: Page, seletor: string, tentativas = 40): Promise<void> {
  await page.evaluate(`document.fonts ? document.fonts.ready : Promise.resolve()`);
  let anterior = "";
  for (let i = 0; i < tentativas; i += 1) {
    const atual = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return "";
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    }, seletor);
    if (atual && atual === anterior) return;
    anterior = atual;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Fecha a página E o contexto isolado dela. */
export async function fecharPagina(page: Page): Promise<void> {
  const contexto = page.browserContext();
  await page.close();
  if (contexto !== contexto.browser().defaultBrowserContext()) await contexto.close();
}
