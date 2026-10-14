"use strict";

/*
 * Cartinha: flashcards nos próprios bullets das notas.
 *
 *   - Pergunta == Resposta          cartão simples
 *   - Pergunta ==                   cartão de lista: cada filho é um item da resposta
 *       - item 1
 *       - item 2
 *
 * Na revisão, os itens de um cartão de lista aparecem escondidos e são revelados um por um.
 *
 * Cada cartão ganha um block id (^ct-xxxxxx) no fim da linha da pergunta. É ele que liga o cartão
 * ao seu histórico de revisão, guardado no data.json do plugin, então dá para editar o texto,
 * mover a linha ou renomear a nota sem perder o progresso.
 *
 * Plugin escrito em JavaScript puro para não exigir build: o Obsidian carrega este arquivo direto.
 */

const {
  Plugin, Modal, ItemView, PluginSettingTab, Setting, Notice, MarkdownRenderer, Component, EditorSuggest,
  TFile, TFolder, editorLivePreviewField, setIcon, normalizePath,
} = require("obsidian");
const { ViewPlugin, Decoration, WidgetType, EditorView, keymap, showTooltip } = require("@codemirror/view");
const { Prec, RangeSetBuilder, EditorState, StateEffect, StateField, findClusterBreak } = require("@codemirror/state");
const { syntaxTree } = require("@codemirror/language");

const PADRAO = {
  novosPorDia: 20,
  intervaloMaximo: 3650,
  pastasIgnoradas: "",
  enterCriaCheckbox: true,
  mostrarSeta: true,
  colarNoCartao: true,
  pastaImagens: "",
  destacarTopicos: true,
  barraSelecao: true,
  tamanhoGrafo: "links",
  raizGrafo: "",
  metaDiaria: 20,
  sonsLicao: true,
};

const NOTAS = [
  { valor: 1, nome: "Errei", classe: "ct-errei" },
  { valor: 2, nome: "Difícil", classe: "ct-dificil" },
  { valor: 3, nome: "Bom", classe: "ct-bom" },
  { valor: 4, nome: "Fácil", classe: "ct-facil" },
];

// ------------------------------------------------------------------ parser

const RE_ITEM = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?(.*)$/;
const RE_ID = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;
const RE_TITULO = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const RE_CERCA = /^[ \t]*(`{3,}|~{3,})/;

function largura(indentacao, tamanhoTab) {
  let n = 0;
  for (const c of indentacao) n += c === "\t" ? tamanhoTab : 1;
  return n;
}

/**
 * Procura o separador " ==" (com espaço antes e espaço ou fim de linha depois), ignorando código
 * inline e fórmulas. Assim o destaque do Obsidian (==texto==) não vira cartão.
 */
function separarCartao(conteudo) {
  const mascarado = conteudo
    .replace(/`[^`]*`/g, (m) => "\0".repeat(m.length))
    .replace(/\$[^$]+\$/g, (m) => "\0".repeat(m.length));
  const m = /[ \t]==(?=[ \t]|$)/.exec(mascarado);
  if (!m) return null;
  const frente = conteudo.slice(0, m.index).trim();
  if (!frente) return null;
  return {
    frente,
    verso: conteudo.slice(m.index + m[0].length).trim(),
    posSeparador: m.index + 1,
  };
}

function separarId(conteudo) {
  const m = RE_ID.exec(conteudo);
  return m ? { texto: conteudo.slice(0, m.index), id: m[1], posId: m.index } : { texto: conteudo, id: null, posId: -1 };
}

function textoDoContexto(conteudo) {
  const semId = separarId(conteudo).texto;
  const sep = separarCartao(semId);
  return (sep ? sep.frente : semId)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, alvo, apelido) => apelido || alvo)
    .replace(/<\/?mark[^>]*>/g, "")
    .replace(/==/g, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * Filhos diretos de um cartão de lista. O que estiver aninhado dentro de um item fica só na nota e
 * não entra na resposta.
 */
function coletarItens(linhas, inicio, indentacaoPai, tamanhoTab) {
  const itens = [];
  let indentacaoFilho = null;
  let fim = inicio;
  for (let j = inicio + 1; j < linhas.length; j++) {
    const linha = linhas[j];
    if (!linha.trim()) continue;
    const w = largura(/^[ \t]*/.exec(linha)[0], tamanhoTab);
    if (w <= indentacaoPai) break;
    fim = j;
    const item = RE_ITEM.exec(linha);
    const texto = separarId(item ? item[3] : linha.trim()).texto.trim();
    if (item && (indentacaoFilho === null || w <= indentacaoFilho)) {
      indentacaoFilho = w;
      itens.push(texto);
    } else if (!item && itens.length && w <= indentacaoFilho) {
      // Texto sem bullet no nível do item é continuação dele
      itens[itens.length - 1] += `\n${texto}`;
    }
  }
  return { itens, fim };
}

// Linhas de texto corrido que não contam como conteúdo a virar cartão
const RE_NAO_CONTEUDO = /^\s*(\||!\[\[|%%|<|---|\$\$|>\s*\[!)/;

/**
 * Lista os cartões de uma nota (`linha` é o índice 0-based da linha da pergunta) e mede a
 * cobertura: quantos trechos de conteúdo (bullets e parágrafos) já estão num cartão.
 * Bullets que só servem de contexto para cartões aninhados não contam nem a favor nem contra.
 */
function analisarNota(conteudoNota, tamanhoTab = 4) {
  const linhas = conteudoNota.split("\n").map((l) => l.replace(/\r$/, ""));
  const cartoes = [];
  const titulos = [];
  const ancestrais = [];
  const trechos = [];
  let cobertoAte = -1;
  let cerca = null;
  let i = 0;

  if (linhas[0] === "---") {
    const fim = linhas.indexOf("---", 1);
    if (fim > 0) i = fim + 1;
  }

  for (; i < linhas.length; i++) {
    const linha = linhas[i];
    const marcaCerca = RE_CERCA.exec(linha);
    if (cerca) {
      if (marcaCerca && marcaCerca[1][0] === cerca[0] && marcaCerca[1].length >= cerca.length) cerca = null;
      continue;
    }
    if (marcaCerca) {
      cerca = marcaCerca[1];
      continue;
    }

    const titulo = RE_TITULO.exec(linha);
    if (titulo) {
      titulos.length = titulo[1].length - 1;
      titulos[titulo[1].length - 1] = titulo[2];
      ancestrais.length = 0;
      continue;
    }

    const item = RE_ITEM.exec(linha);
    if (!item) {
      if (linha.trim() && !/^[ \t]/.test(linha)) ancestrais.length = 0;
      if (i > cobertoAte && linha.trim().length >= 25 && !RE_NAO_CONTEUDO.test(linha)) {
        trechos.push({ coberto: false, contexto: false });
      }
      continue;
    }

    const indentacao = largura(item[1], tamanhoTab);
    while (ancestrais.length && ancestrais[ancestrais.length - 1].indentacao >= indentacao) ancestrais.pop();

    const trecho = { coberto: i <= cobertoAte, contexto: false };
    if (item[3].trim()) trechos.push(trecho);

    const { texto, id } = separarId(item[3]);
    const sep = separarCartao(texto);
    if (sep) {
      const { itens, fim } = sep.verso ? { itens: [], fim: i } : coletarItens(linhas, i, indentacao, tamanhoTab);
      if (sep.verso || itens.length) {
        cartoes.push({
          linha: i,
          textoLinha: linha,
          id,
          frente: sep.frente,
          verso: sep.verso,
          itens,
          contexto: [...titulos.filter(Boolean), ...ancestrais.map((a) => a.texto)],
        });
        trecho.coberto = true;
        cobertoAte = Math.max(cobertoAte, fim);
        for (const a of ancestrais) a.trecho.contexto = true;
      }
    }
    ancestrais.push({ indentacao, texto: textoDoContexto(item[3]), trecho });
  }

  const cobertos = trechos.filter((t) => t.coberto).length;
  const semCartao = trechos.filter((t) => !t.coberto && !t.contexto).length;
  return { cartoes, cobertos, semCartao };
}

function extrairCartoes(conteudoNota, tamanhoTab = 4) {
  return analisarNota(conteudoNota, tamanhoTab).cartoes;
}

/**
 * Situação da cobertura de uma nota. Os limites são uma heurística: a ideia é apontar notas com
 * muito conteúdo ainda fora dos cartões, não exigir que todo bullet vire cartão.
 */
function situacaoCobertura({ cobertos, semCartao }) {
  const total = cobertos + semCartao;
  const proporcao = total ? cobertos / total : 1;
  if (semCartao === 0) return { nivel: "ok", texto: "Tudo coberto", proporcao };
  if (proporcao >= 0.6) return { nivel: "ok", texto: "Boa cobertura", proporcao };
  if (proporcao >= 0.3) return { nivel: "medio", texto: "Pode ter mais cards", proporcao };
  return { nivel: "baixo", texto: "Faltam cards", proporcao };
}

// ------------------------------------------------------------------ agendamento

function hojeISO(data = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}`;
}

function somarDias(iso, dias) {
  const [a, m, d] = iso.split("-").map(Number);
  return hojeISO(new Date(a, m - 1, d + dias));
}

/**
 * Agendamento de repetição espaçada com fator de facilidade. Errar deixa o cartão para hoje de novo e
 * reduz a facilidade. Os outros botões multiplicam o intervalo pela facilidade.
 */
function agendar(estado, nota, hoje, intervaloMaximo) {
  const e = estado ? { ...estado } : { intervalo: 0, facilidade: 2.5, repeticoes: 0, lapsos: 0 };
  const ant = e.intervalo;
  let intervalo;

  if (nota === 1) {
    if (e.repeticoes > 0) e.lapsos += 1;
    e.facilidade = Math.max(1.3, e.facilidade - 0.2);
    intervalo = 0;
  } else if (ant === 0) {
    // Primeira resposta certa: 1 dia, ou 4 com Fácil
    intervalo = nota === 4 ? 4 : 1;
    if (nota === 4) e.facilidade += 0.15;
    if (nota === 2) e.facilidade = Math.max(1.3, e.facilidade - 0.15);
  } else if (nota === 2) {
    e.facilidade = Math.max(1.3, e.facilidade - 0.15);
    intervalo = Math.max(ant + 1, Math.round(ant * 1.2));
  } else if (nota === 3) {
    intervalo = Math.max(ant + 1, Math.round(ant * e.facilidade));
  } else {
    intervalo = Math.max(ant + 2, Math.round(ant * e.facilidade * 1.3));
    e.facilidade += 0.15;
  }

  e.intervalo = Math.min(intervalo, intervaloMaximo);
  e.repeticoes += 1;
  e.vencimento = somarDias(hoje, e.intervalo);
  e.ultima = hoje;
  e.facilidade = Math.round(e.facilidade * 100) / 100;
  return e;
}

function formatarIntervalo(dias) {
  if (dias === 0) return "hoje";
  if (dias < 30) return `${dias}d`;
  if (dias < 365) return `${Math.round(dias / 30)}m`;
  return `${(dias / 365).toFixed(1).replace(/\.0$/, "")}a`;
}

// ------------------------------------------------------------------ estatísticas

// Cada resposta vira uma linha do histórico: [instante (ms), id, nota, intervalo antes (-1 se era
// novo), intervalo depois, tempo de resposta (ms)]
const H = { instante: 0, id: 1, nota: 2, antes: 3, depois: 4, tempo: 5 };
const MADURO = 21; // dias: a partir daqui o cartão deixa de ser jovem e vira maduro

function diasEntre(deISO, ateISO) {
  const [a1, m1, d1] = deISO.split("-").map(Number);
  const [a2, m2, d2] = ateISO.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86400000);
}

function maturidade(estado) {
  if (!estado) return "novo";
  if (estado.intervalo === 0) return "aprendendo";
  return estado.intervalo < MADURO ? "jovem" : "maduro";
}

/** Retenção = respostas que não foram "Errei", só entre cartões que já estavam em revisão. */
function retencao(linhas) {
  const revisoes = linhas.filter((h) => h[H.antes] > 0);
  if (!revisoes.length) return null;
  return revisoes.filter((h) => h[H.nota] > 1).length / revisoes.length;
}

/**
 * Tudo o que a tela de estatísticas mostra, a partir dos cartões encontrados no vault, do estado de
 * agendamento e do histórico. `periodo` é o número de dias do recorte do histórico (0 = tudo).
 */
/** Dias seguidos em que `estudou(dia)` é verdade, terminando hoje (ou ontem, se hoje ainda não teve). */
function sequenciaDeDias(estudou, hoje) {
  let n = 0;
  for (let d = estudou(hoje) ? 0 : 1; estudou(somarDias(hoje, -d)); d++) n += 1;
  return n;
}

/**
 * `diasExtras` são outros dias com estudo (as lições), que também contam na sequência.
 */
function calcularEstatisticas({ cartoes, estados, historico, notas = [], agora = new Date(), periodo = 30, diasExtras = [] }) {
  const hoje = hojeISO(agora);
  const diaDe = (h) => hojeISO(new Date(h[H.instante]));

  const contagem = { novo: 0, aprendendo: 0, jovem: 0, maduro: 0 };
  const previsao = Array(30).fill(0);
  let vencidos = 0;
  for (const c of cartoes) {
    const estado = c.id && estados[c.id];
    contagem[maturidade(estado)] += 1;
    if (!estado) continue;
    const dias = Math.max(0, diasEntre(hoje, estado.vencimento));
    if (dias === 0) vencidos += 1;
    if (dias < previsao.length) previsao[dias] += 1;
  }

  const porDia = new Map();
  for (const h of historico) {
    const dia = diaDe(h);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(h);
  }
  const deHoje = porDia.get(hoje) || [];

  const extras = new Set(diasExtras);
  const estudou = (dia) => porDia.has(dia) || extras.has(dia);
  const sequencia = sequenciaDeDias(estudou, hoje);
  const semana = [];
  for (let d = 6; d >= 0; d--) {
    const dia = somarDias(hoje, -d);
    semana.push({ dia, estudou: estudou(dia), hoje: d === 0 });
  }
  let melhorSequencia = 0;
  let corrente = 0;
  let anterior = null;
  for (const dia of [...new Set([...porDia.keys(), ...extras])].sort()) {
    corrente = anterior && somarDias(anterior, 1) === dia ? corrente + 1 : 1;
    melhorSequencia = Math.max(melhorSequencia, corrente);
    anterior = dia;
  }

  // Acertos: respostas que não foram "Errei", nos últimos 7 dias e nos 7 anteriores
  const acertoEntre = (de, ate) => {
    const linhas = historico.filter((h) => diaDe(h) >= de && diaDe(h) <= ate);
    return linhas.length ? linhas.filter((h) => h[H.nota] > 1).length / linhas.length : null;
  };
  const semana7 = historico.filter((h) => diaDe(h) >= somarDias(hoje, -6));
  const acertos = {
    atual: acertoEntre(somarDias(hoje, -6), hoje),
    anterior: acertoEntre(somarDias(hoje, -13), somarDias(hoje, -7)),
    total: semana7.length,
    respostas: [1, 2, 3, 4].map((n) => semana7.filter((h) => h[H.nota] === n).length),
  };

  // Cartões com "Errei" nas últimas 24 horas, do mais recente para o mais antigo
  const idsErrados = [];
  const limite24h = agora.getTime() - 86400000;
  for (let i = historico.length - 1; i >= 0 && historico[i][H.instante] >= limite24h; i--) {
    const h = historico[i];
    if (h[H.nota] === 1 && !idsErrados.includes(h[H.id])) idsErrados.push(h[H.id]);
  }

  const primeiroDia = historico.length ? diaDe(historico[0]) : hoje;
  const dias = periodo ? periodo : Math.min(365, diasEntre(primeiroDia, hoje) + 1);
  const atividade = [];
  for (let d = dias - 1; d >= 0; d--) {
    const dia = somarDias(hoje, -d);
    const linhas = porDia.get(dia) || [];
    atividade.push({ dia, total: linhas.length, erros: linhas.filter((h) => h[H.nota] === 1).length });
  }
  const inicio = somarDias(hoje, -(dias - 1));
  const noPeriodo = historico.filter((h) => diaDe(h) >= inicio);
  const respostas = [1, 2, 3, 4].map((n) => noPeriodo.filter((h) => h[H.nota] === n).length);
  const tempoPeriodo = noPeriodo.reduce((s, h) => s + (h[H.tempo] || 0), 0);

  // Mapa de calor: as últimas 26 semanas completas, começando num domingo
  const semanas = 26;
  const inicioMapa = somarDias(hoje, -((semanas - 1) * 7) - agora.getDay());
  const mapa = [];
  for (let d = 0; d <= diasEntre(inicioMapa, hoje); d++) {
    const dia = somarDias(inicioMapa, d);
    mapa.push({ dia, total: (porDia.get(dia) || []).length });
  }

  const porId = new Map(cartoes.filter((c) => c.id).map((c) => [c.id, c]));
  const dificeis = [...porId.values()]
    .map((c) => ({ cartao: c, estado: estados[c.id] }))
    .filter((x) => x.estado && x.estado.lapsos > 0)
    .sort((a, b) => b.estado.lapsos - a.estado.lapsos || a.estado.facilidade - b.estado.facilidade)
    .slice(0, 8);

  const porNota = notas.map((n) => {
    const ids = new Set(n.cartoes.map((c) => c.id).filter(Boolean));
    const cont = { novo: 0, aprendendo: 0, jovem: 0, maduro: 0 };
    let vencidosNota = 0;
    for (const c of n.cartoes) {
      const estado = c.id && estados[c.id];
      cont[maturidade(estado)] += 1;
      if (estado && estado.vencimento <= hoje) vencidosNota += 1;
    }
    return {
      arquivo: n.arquivo,
      total: n.cartoes.length,
      contagem: cont,
      vencidos: vencidosNota,
      retencao: retencao(noPeriodo.filter((h) => ids.has(h[H.id]))),
      cobertura: situacaoCobertura(n),
      semCartao: n.semCartao,
    };
  });

  return {
    total: cartoes.length,
    contagem,
    vencidos,
    previsao,
    hoje: { total: deHoje.length, tempo: deHoje.reduce((s, h) => s + (h[H.tempo] || 0), 0) },
    ontem: (porDia.get(somarDias(hoje, -1)) || []).length,
    sequencia,
    melhorSequencia,
    semana,
    acertos,
    errosRecentes: idsErrados.map((id) => porId.get(id)).filter(Boolean),
    atividade,
    respostas,
    retencao: {
      jovens: retencao(noPeriodo.filter((h) => h[H.antes] > 0 && h[H.antes] < MADURO)),
      maduros: retencao(noPeriodo.filter((h) => h[H.antes] >= MADURO)),
      geral: retencao(noPeriodo),
    },
    tempoMedio: noPeriodo.length ? tempoPeriodo / noPeriodo.length : 0,
    revisoesPeriodo: noPeriodo.length,
    mapa,
    dificeis,
    porNota,
  };
}

/** Id do cartão próprio de um item de lista, ligado ao cartão e ao texto do item. */
function idDoItem(idCartao, textoItem) {
  return `${idCartao}~${hashTexto(textoItem.trim())}`;
}

function novoId(existentes) {
  let id;
  do id = "ct-" + Math.random().toString(36).slice(2, 8);
  while (existentes.has(id));
  return id;
}

// ------------------------------------------------------------------ editor

class SetaWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return criarSeta();
  }
  ignoreEvent() {
    return false;
  }
}

function criarSeta() {
  const el = document.createElement("span");
  el.className = "ct-seta";
  el.textContent = "→";
  return el;
}

const SETA = Decoration.replace({ widget: new SetaWidget() });
// Avisa os editores que os anexos mudaram, para redesenhar os clipes sem o texto ter mudado
const ANEXOS_MUDARAM = StateEffect.define();

/**
 * Clipe no fim da linha do cartão. Com anexos, mostra a quantidade. Sem anexos, só aparece na
 * linha do cursor ou com o mouse em cima.
 */
class ClipeWidget extends WidgetType {
  constructor(plugin, quantidade) {
    super();
    this.plugin = plugin;
    this.quantidade = quantidade;
  }
  eq(outro) {
    return outro.quantidade === this.quantidade;
  }
  toDOM(view) {
    const el = document.createElement("span");
    el.className = this.quantidade ? "ct-clipe" : "ct-clipe ct-clipe-vazio";
    setIcon(el.createSpan("ct-clipe-icone"), "paperclip");
    if (this.quantidade) el.createSpan({ text: String(this.quantidade) });
    if (!this.quantidade) el.setAttribute("aria-label", "Anexar ao cartão");
    el.addEventListener("mouseenter", () => this.plugin.mostrarPrevia(el, view));
    el.addEventListener("mouseleave", () => this.plugin.fecharPrevia());
    el.addEventListener("mousedown", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.plugin.abrirAnexosEm(view, view.posAtDOM(el));
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
const ESCONDER = Decoration.replace({});

function emCodigo(state, pos) {
  for (let no = syntaxTree(state).resolveInner(pos, 1); no; no = no.parent) {
    if (/codeblock|inline-code|math|comment|frontmatter/i.test(no.type.name)) return true;
  }
  return false;
}

/** Posições de um cartão numa linha do editor, ou null se a linha não é cartão. */
function analisarLinhaEditor(texto) {
  const item = RE_ITEM.exec(texto);
  if (!item) return null;
  const inicio = texto.length - item[3].length;
  const { texto: semId, id, posId } = separarId(item[3]);
  const sep = separarCartao(semId);
  if (!sep) return null;
  return {
    item,
    separador: inicio + sep.posSeparador,
    lista: !sep.verso,
    id,
    inicioId: id ? inicio + posId : -1,
  };
}

/**
 * Trecho " ^ct-xxxxxx" escondido no fim da linha `pos`, ou null. Ele fica oculto mesmo com o
 * cursor na linha, por isso o editor o trata como um bloco que não se edita (ver filtroDoId).
 */
function idOculto(plugin, state, pos) {
  if (!plugin.config.mostrarSeta || !state.field(editorLivePreviewField, false)) return null;
  const linha = state.doc.lineAt(pos);
  if (!linha.text.includes("^ct-")) return null;
  const c = analisarLinhaEditor(linha.text);
  if (!c || !c.id || !c.id.startsWith("ct-")) return null;
  return { linha, inicio: linha.from + c.inicioId, fim: linha.to };
}

function criarDecoracoes(plugin) {
  const vp = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.construir(view);
      }
      update(u) {
        const modoMudou = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
        const anexos = u.transactions.some((t) => t.effects.some((e) => e.is(ANEXOS_MUDARAM)));
        if (u.docChanged || u.viewportChanged || u.selectionSet || modoMudou || anexos) this.construir(u.view);
      }
      construir(view) {
        const todas = new RangeSetBuilder();
        const ids = new RangeSetBuilder();
        const { state } = view;
        if (plugin.config.mostrarSeta && state.field(editorLivePreviewField, false)) {
          for (const { from, to } of view.visibleRanges) {
            for (let pos = from; pos <= to; ) {
              const linha = state.doc.lineAt(pos);
              pos = linha.to + 1;
              if (!linha.text.includes("==")) continue;
              const c = analisarLinhaEditor(linha.text);
              if (!c || emCodigo(state, linha.from + c.separador)) continue;
              // A seta só aparece com o cursor fora da linha, o id fica sempre escondido
              const cursorNaLinha = state.selection.ranges.some((r) => r.from <= linha.to && r.to >= linha.from);
              if (!cursorNaLinha) todas.add(linha.from + c.separador, linha.from + c.separador + 2, SETA);
              if (c.id && c.id.startsWith("ct-")) {
                todas.add(linha.from + c.inicioId, linha.to, ESCONDER);
                ids.add(linha.from + c.inicioId, linha.to, ESCONDER);
              }
              const anexos = c.id ? plugin.anexosDe(c.id).length : 0;
              todas.add(linha.to, linha.to, Decoration.widget({ widget: new ClipeWidget(plugin, anexos), side: 1 }));
            }
          }
        }
        this.decorations = todas.finish();
        this.ids = ids.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
  // O cursor pula o id inteiro, sem parar no meio dele
  const atomico = EditorView.atomicRanges.of((view) => view.plugin(vp)?.ids ?? Decoration.none);
  return [vp, atomico, filtroDoId(plugin)];
}

/**
 * Protege o id escondido: o que for digitado depois dele vai para antes dele, o Backspace logo
 * depois dele apaga o caractere anterior ao id, e o Delete logo antes dele não faz nada.
 */
function filtroDoId(plugin) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged && tr.selection && tr.isUserEvent("select") && !tr.isUserEvent("select.pointer")) {
      return pularId(plugin, tr);
    }
    if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
    let mudancas = 0;
    let m = null;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserido) => {
      mudancas += 1;
      m = { fromA, toA, texto: inserido.toString() };
    });
    if (mudancas !== 1 || m.texto.includes("\n")) return tr;
    const id = idOculto(plugin, tr.startState, m.fromA);
    if (!id || m.fromA < id.inicio || m.toA > id.fim) return tr;

    if (m.texto && m.fromA === m.toA) {
      if (m.fromA === id.inicio) return tr;
      return {
        changes: { from: id.inicio, insert: m.texto },
        selection: { anchor: id.inicio + m.texto.length },
        userEvent: "input.type",
        scrollIntoView: true,
      };
    }
    if (!m.texto && tr.isUserEvent("delete.backward")) {
      const { linha } = id;
      if (id.inicio <= linha.from) return [];
      const antes = linha.from + findClusterBreak(linha.text, id.inicio - linha.from, false);
      return { changes: { from: antes, to: id.inicio }, selection: { anchor: antes }, userEvent: "delete.backward" };
    }
    if (!m.texto) return [];
    return tr;
  });
}

/** Enter no fim de "Pergunta ==" cria um bullet filho para começar a lista de respostas. */
function enterAposSeparador(plugin, view) {
  if (!plugin.config.enterCriaCheckbox) return false;
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const linha = state.doc.lineAt(sel.head);
  const depois = linha.text.slice(sel.head - linha.from);
  if (depois.trim() && !RE_ID.test(" " + depois.trim())) return false;

  const c = analisarLinhaEditor(linha.text);
  if (!c || !c.lista || emCodigo(state, linha.from + c.separador)) return false;

  const indentacao = c.item[1];
  const usaTab = plugin.app.vault.getConfig?.("useTab") ?? true;
  const unidade = (indentacao.includes(" ") && !indentacao.includes("\t")) || !usaTab
    ? " ".repeat(plugin.app.vault.getConfig?.("tabSize") ?? 4)
    : "\t";
  const inserir = `\n${indentacao}${unidade}- `;
  view.dispatch({
    changes: { from: linha.to, insert: inserir },
    selection: { anchor: linha.to + inserir.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/**
 * Antes e depois do id escondido o cursor aparece no mesmo lugar, então andar com as setas entre
 * esses dois pontos parece não fazer nada. A seta segue direto para a linha seguinte ou anterior.
 */
function pularId(plugin, tr) {
  const antes = tr.startState.selection.main;
  const depois = tr.selection.main;
  if (!antes.empty || !depois.empty || tr.selection.ranges.length > 1) return tr;
  const doc = tr.startState.doc;
  const id = idOculto(plugin, tr.startState, depois.head);
  if (!id) return tr;
  if (antes.head === id.inicio && depois.head === id.fim && id.fim < doc.length) {
    return { selection: { anchor: id.fim + 1 }, userEvent: "select", scrollIntoView: true };
  }
  if (antes.head === id.fim + 1 && depois.head === id.fim) {
    return { selection: { anchor: id.inicio }, userEvent: "select", scrollIntoView: true };
  }
  return tr;
}

/**
 * Com o cursor logo antes do id escondido, o Enter quebraria a linha e levaria o id junto. O cursor
 * vai para depois do id e o Enter segue normal (continuação de lista do Obsidian).
 */
function enterAntesDoId(plugin, view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const id = idOculto(plugin, view.state, sel.head);
  if (id && sel.head >= id.inicio && sel.head < id.fim) view.dispatch({ selection: { anchor: id.fim } });
  return false;
}

/** Popup "Começar lista de respostas" que aparece ao terminar um bullet com "==". */
class SugestaoLista extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor) {
    if (!this.plugin.config.enterCriaCheckbox) return null;
    const linha = editor.getLine(cursor.line);
    const depois = linha.slice(cursor.ch);
    if (depois.trim() && !RE_ID.test(" " + depois.trim())) return null;
    const c = analisarLinhaEditor(linha);
    if (!c || !c.lista || cursor.ch < c.separador + 2) return null;
    if (editor.cm && emCodigo(editor.cm.state, editor.posToOffset({ line: cursor.line, ch: c.separador }))) return null;
    return { start: cursor, end: cursor, query: "" };
  }

  getSuggestions() {
    return ["lista"];
  }

  renderSuggestion(_valor, el) {
    el.addClass("ct-sugestao");
    el.appendChild(criarSeta());
    el.createSpan({ text: "Começar lista de respostas" });
    el.createSpan({ cls: "ct-sugestao-tecla", text: "Enter" });
  }

  selectSuggestion() {
    const view = this.context?.editor?.cm;
    this.close();
    if (view) enterAposSeparador(this.plugin, view);
  }
}

/** Modo leitura: troca o " == " dos bullets pela mesma seta do editor. */
function processarLeitura(plugin, el) {
  if (!plugin.config.mostrarSeta) return;
  for (const li of el.querySelectorAll("li")) {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    for (let no = walker.nextNode(); no; no = walker.nextNode()) {
      if (no.parentElement.closest("li") !== li || no.parentElement.closest("code, pre, .math")) continue;
      const m = /[ \t]==(?=\s|$)/.exec(no.textContent);
      if (!m) continue;
      const resto = no.splitText(m.index + 1);
      resto.textContent = resto.textContent.slice(2);
      no.parentNode.insertBefore(criarSeta(), resto);
      li.addClass("ct-cartao");
      break;
    }
  }
}

// ------------------------------------------------------------------ aparência das notas

/*
 * Tópicos: bullets que agrupam outros bullets e não são cartões ganham um fundo, mais forte no
 * primeiro nível. É só aparência (decoração do editor e classe no modo leitura): a nota não muda.
 *
 * Barra de seleção: ao selecionar um trecho de uma linha, aparece uma barrinha com negrito e
 * marca-texto. O amarelo é o ==destaque== do Obsidian; as outras cores são <mark class="ct-mt-…">,
 * que o Obsidian desenha no Live Preview e no modo leitura.
 */

const CORES_MARCA = [
  { nome: "Amarelo", chave: "amarelo", abre: "==", fecha: "==" },
  { nome: "Verde", chave: "verde", abre: '<mark class="ct-mt-verde">', fecha: "</mark>" },
  { nome: "Azul", chave: "azul", abre: '<mark class="ct-mt-azul">', fecha: "</mark>" },
  { nome: "Rosa", chave: "rosa", abre: '<mark class="ct-mt-rosa">', fecha: "</mark>" },
  { nome: "Roxo", chave: "roxo", abre: '<mark class="ct-mt-roxo">', fecha: "</mark>" },
];
const RE_MARCA_ABRE = /(==|<mark class="ct-mt-[a-z]+">)$/;
const RE_MARCA_FECHA = /^(==|<\/mark>)/;

/** Tira marca-texto (== e <mark>) de um trecho. */
function semMarcas(texto) {
  return texto.replace(/<mark[^>]*>|<\/mark>/g, "").replace(/==/g, "");
}

/** Nível de um bullet pela indentação: 0 no primeiro nível. */
function nivelDaIndentacao(indentacao, tamanhoTab) {
  return Math.round(largura(indentacao, tamanhoTab) / tamanhoTab);
}

/** Linha `numero` (1-based) é um tópico: bullet com texto, que não é cartão e tem filhos. */
function topicoNaLinha(doc, numero, tamanhoTab) {
  const linha = doc.line(numero);
  const item = RE_ITEM.exec(linha.text);
  if (!item || !item[3].trim() || analisarLinhaEditor(linha.text)) return null;
  const w = largura(item[1], tamanhoTab);
  for (let n = numero + 1; n <= doc.lines && n <= numero + 50; n++) {
    const prox = doc.line(n).text;
    if (!prox.trim()) continue;
    if (largura(/^[ \t]*/.exec(prox)[0], tamanhoTab) <= w) return null;
    const { posId } = separarId(item[3]);
    const inicio = linha.from + linha.text.length - item[3].length;
    return { inicio, fim: posId >= 0 ? inicio + posId : linha.to, nivel: Math.min(2, nivelDaIndentacao(item[1], tamanhoTab)) };
  }
  return null;
}

function criarTopicos(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.construir(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged) this.decorations = this.construir(u.view);
      }
      construir(view) {
        const b = new RangeSetBuilder();
        if (!plugin.config.destacarTopicos) return b.finish();
        const { state } = view;
        const tab = plugin.tamanhoTab();
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const linha = state.doc.lineAt(pos);
            pos = linha.to + 1;
            const t = topicoNaLinha(state.doc, linha.number, tab);
            if (!t || t.fim <= t.inicio || emCodigo(state, t.inicio)) continue;
            b.add(t.inicio, t.fim, Decoration.mark({ class: `ct-topico ct-topico-${t.nivel}` }));
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/** Modo leitura: o texto dos bullets com sublista (e que não são cartões) vira um tópico. */
function topicosNaLeitura(plugin, el) {
  if (!plugin.config.destacarTopicos) return;
  for (const li of el.querySelectorAll("li")) {
    if (li.hasClass("ct-cartao") || li.querySelector(":scope > .ct-topico")) continue;
    if (!li.querySelector(":scope > ul, :scope > ol")) continue;
    let nivel = 0;
    for (let p = li.parentElement?.closest("li"); p && el.contains(p); p = p.parentElement?.closest("li")) nivel++;
    const conteudo = [...li.childNodes].filter((n) => {
      if (n.nodeType === Node.TEXT_NODE) return !!n.textContent.trim();
      if (n.nodeType !== Node.ELEMENT_NODE) return false;
      return !n.matches("ul, ol, .list-bullet, .collapse-indicator, .list-collapse-indicator, .task-list-item-checkbox");
    });
    if (!conteudo.length) continue;
    const span = createSpan({ cls: `ct-topico ct-topico-${Math.min(2, nivel)}` });
    li.insertBefore(span, conteudo[0]);
    for (const n of conteudo) span.appendChild(n);
  }
}

/** Marca-texto que envolve exatamente a seleção, se houver: { de, ate, chave }. */
function marcaEmVolta(state, from, to) {
  const antes = RE_MARCA_ABRE.exec(state.sliceDoc(Math.max(0, from - 40), from));
  const depois = RE_MARCA_FECHA.exec(state.sliceDoc(to, to + 10));
  if (!antes || !depois || (antes[1] === "==") !== (depois[1] === "==")) return null;
  const chave = antes[1] === "==" ? "amarelo" : /ct-mt-([a-z]+)/.exec(antes[1])[1];
  return { de: from - antes[1].length, ate: to + depois[1].length, chave };
}

/** Aplica (ou tira, se já estiver) a cor na seleção. Outra cor que estiver em volta é trocada. */
function aplicarMarca(view, cor) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const texto = semMarcas(state.sliceDoc(from, to));
  const volta = marcaEmVolta(state, from, to);
  const de = volta ? volta.de : from;
  const ate = volta ? volta.ate : to;
  const desligar = !cor || (volta && volta.chave === cor.chave);
  const insert = desligar ? texto : cor.abre + texto + cor.fecha;
  const inicio = de + (desligar ? 0 : cor.abre.length);
  view.dispatch({ changes: { from: de, to: ate, insert }, selection: { anchor: inicio, head: inicio + texto.length }, userEvent: "input" });
}

function alternarNegrito(view) {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (state.sliceDoc(from - 2, from) === "**" && state.sliceDoc(to, to + 2) === "**") {
    view.dispatch({ changes: [{ from: from - 2, to: from }, { from: to, to: to + 2 }], selection: { anchor: from - 2, head: to - 2 }, userEvent: "input" });
  } else {
    view.dispatch({ changes: [{ from, insert: "**" }, { from: to, insert: "**" }], selection: { anchor: from + 2, head: to + 2 }, userEvent: "input" });
  }
}

function criarBarraSelecao(view) {
  const barra = document.createElement("div");
  barra.className = "ct-barra-selecao";
  // Clicar na barra não pode tirar a seleção do editor
  barra.addEventListener("mousedown", (evt) => evt.preventDefault());
  const botao = (cls, rotulo, acao) => {
    const b = barra.createEl("button", { cls: `ct-barra-botao ${cls}`, attr: { "aria-label": rotulo } });
    b.addEventListener("click", () => acao(view));
    return b;
  };
  setIcon(botao("", "Negrito", alternarNegrito), "bold");
  barra.createDiv("ct-barra-divisor");
  for (const cor of CORES_MARCA) botao(`ct-barra-cor ct-cor-${cor.chave}`, `Marca-texto ${cor.nome.toLowerCase()}`, (v) => aplicarMarca(v, cor));
  barra.createDiv("ct-barra-divisor");
  setIcon(botao("", "Tirar marca-texto", (v) => aplicarMarca(v, null)), "eraser");
  return barra;
}

/** Barra de formatação sobre a seleção (só dentro de uma linha, para não quebrar a marcação). */
function barraDeSelecao(plugin) {
  const dicas = (state) => {
    const sel = state.selection.main;
    if (!plugin.config.barraSelecao || sel.empty || state.selection.ranges.length > 1) return [];
    if (state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number) return [];
    return [{ pos: sel.from, above: true, arrow: false, create: (view) => ({ dom: criarBarraSelecao(view) }) }];
  };
  return StateField.define({
    create: dicas,
    update: (atual, tr) => (tr.docChanged || tr.selection ? dicas(tr.state) : atual),
    provide: (campo) => showTooltip.computeN([campo], (state) => state.field(campo)),
  });
}

// ------------------------------------------------------------------ revisão

class ModalRevisao extends Modal {
  constructor(plugin, fila, { titulo, livre, todos }) {
    super(plugin.app);
    this.plugin = plugin;
    this.fila = fila;
    this.titulo = titulo;
    this.livre = livre;
    this.todos = todos || [];
    this.total = fila.length;
    this.feitos = 0;
    this.contagem = { 1: 0, 2: 0, 3: 0, 4: 0 };
    this.componente = null;
    this.teclas = (evt) => this.aoTeclar(evt);
  }

  onOpen() {
    this.modalEl.addClass("ct-modal", "ct-modal-revisao");
    document.addEventListener("keydown", this.teclas, true);
    this.mostrar();
  }

  onClose() {
    document.removeEventListener("keydown", this.teclas, true);
    this.componente?.unload();
    this.contentEl.empty();
    this.plugin.atualizarStatus();
  }

  aoTeclar(evt) {
    if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.target.closest?.("input[type=text], textarea")) return;
    if (!this.atual) return;
    let tratado = true;
    if (evt.key === " ") this.revelarProximo();
    else if (this.revelado && ["1", "2", "3", "4"].includes(evt.key)) this.avaliar(Number(evt.key));
    else if (evt.key.toLowerCase() === "x" && this.podeMarcar && this.ultimoRevelado != null) this.alternarEsquecido(this.ultimoRevelado);
    else tratado = false;
    if (tratado) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  renderizar(markdown, el) {
    const c = this.atual;
    MarkdownRenderer.render(this.app, markdown, el, c.arquivo.path, this.componente);
  }

  /**
   * Coluna à direita com os anexos do cartão, aberta pelo botão de clipe. Aberta uma vez, ela
   * continua aberta nos cartões seguintes, mas só depois de revelar a resposta, para não entregá-la.
   * Antes disso, só aparece se o clipe for clicado naquele cartão.
   */
  mostrarAnexos(c) {
    if (!this.lateral) this.lateral = this.modalEl.createDiv("ct-lateral");
    this.lateral.empty();
    // O item de lista que virou cartão mostra os anexos do cartão de onde ele veio
    const id = c && (c.pai || c.id);
    const liberado = this.revelado || this.anexosNesteCartao;
    const visivel = !!(c && this.anexosAbertos && liberado && this.plugin.anexosDe(id).length);
    this.modalEl.toggleClass("ct-com-anexos", visivel);
    this.botaoClipe?.toggleClass("is-active", visivel);
    if (!visivel) return;
    renderizarAnexos(this.plugin, this.lateral.createDiv("ct-anexos"), id, {
      caminhoNota: c.arquivo.path,
      componente: this.componente,
    });
  }

  mostrar() {
    this.componente?.unload();
    this.componente = new Component();
    this.componente.load();
    const { contentEl } = this;
    contentEl.empty();

    if (!this.fila.length) return this.mostrarFim();

    const c = (this.atual = this.fila[0]);
    this.revelado = false;
    this.revelados = 0;
    this.inicioCartao = Date.now();

    const total = this.feitos + this.fila.length;
    const topo = contentEl.createDiv("ct-topo");
    topo.createDiv({ cls: "ct-contexto", text: c.arquivo.basename });
    if (this.livre) topo.createSpan({ cls: "ct-chip", text: "prática livre" });
    if (c.itemAlvo != null) topo.createSpan({ cls: "ct-chip", text: "item da lista", attr: { "aria-label": "Item que você não lembrou numa revisão. Sai daqui quando ficar maduro." } });

    // Barra de progresso: começa onde a do cartão anterior parou e anda até a posição nova
    const progresso = contentEl.createDiv("ct-progresso-linha");
    const cheio = progresso.createDiv("ct-progresso").createDiv("ct-progresso-cheio");
    const fracao = this.feitos / total;
    cheio.style.width = `${(this.fracaoAnterior ?? fracao) * 100}%`;
    window.requestAnimationFrame(() => (cheio.style.width = `${fracao * 100}%`));
    this.fracaoAnterior = fracao;
    progresso.createSpan({ cls: "ct-contador", text: `${this.feitos + 1} / ${total}` });
    const quantidade = this.plugin.anexosDe(c.pai || c.id).length;
    this.anexosNesteCartao = false;
    this.botaoClipe = null;
    if (quantidade) {
      const clipe = (this.botaoClipe = topo.createEl("button", { cls: "ct-icone ct-icone-clipe clickable-icon", attr: { "aria-label": "Anexos" } }));
      setIcon(clipe.createSpan(), "paperclip");
      clipe.createSpan({ text: String(quantidade) });
      clipe.addEventListener("click", () => {
        const abrir = !this.modalEl.hasClass("ct-com-anexos");
        this.anexosAbertos = abrir;
        this.anexosNesteCartao = abrir;
        this.mostrarAnexos(c);
      });
    }
    const abrir = topo.createEl("button", { cls: "ct-icone clickable-icon", attr: { "aria-label": "Abrir na nota" } });
    setIcon(abrir, "arrow-up-right");
    abrir.addEventListener("click", () => this.abrirNota(c));
    this.mostrarAnexos(c);

    const palco = contentEl.createDiv("ct-palco");
    this.mostrarContexto(palco, c);
    this.renderizar(c.frente, palco.createDiv("ct-frente"));
    const resposta = palco.createDiv("ct-resposta");
    this.alvoItem = null;
    this.podeMarcar = false;
    this.dicaMarcar = null;
    this.esquecidos = new Set();
    this.ultimoRevelado = null;
    if (c.itemAlvo != null) {
      // Item que virou cartão: os outros itens ficam à vista como pista e só ele fica escondido
      resposta.addClass("ct-lista");
      this.linhasItens = null;
      c.itens.forEach((texto, i) => {
        const alvo = i === c.itemAlvo;
        const linha = resposta.createDiv(alvo ? "ct-item ct-oculto ct-item-alvo" : "ct-item ct-item-pista");
        linha.createSpan("ct-marcador");
        const corpo = linha.createDiv("ct-item-texto");
        if (!alvo) return this.renderizar(texto, corpo);
        corpo.createSpan({ cls: "ct-esqueleto", text: "?" });
        linha.addEventListener("click", () => this.revelarProximo());
        this.alvoItem = { linha, corpo, texto };
      });
    } else if (c.itens.length) {
      resposta.addClass("ct-lista");
      // Itens revelados podem ser marcados como "não lembrei" e virar cartões próprios
      this.podeMarcar = !this.livre && !!c.id;
      resposta.toggleClass("ct-lista-marcavel", this.podeMarcar);
      this.linhasItens = c.itens.map((texto, i) => {
        const linha = resposta.createDiv("ct-item ct-oculto");
        linha.createSpan("ct-marcador");
        const corpo = linha.createDiv("ct-item-texto");
        corpo.createSpan({ cls: "ct-esqueleto", text: `${i + 1}` });
        linha.addEventListener("click", () => (linha.hasClass("ct-oculto") ? this.revelarItem(i) : this.alternarEsquecido(i)));
        return { linha, corpo, texto };
      });
      if (this.podeMarcar) {
        this.dicaMarcar = palco.createDiv({ cls: "ct-dica ct-dica-marcar", text: "Clique nos itens que você não lembrou (ou aperte X logo depois de revelar). Eles viram cartões para revisar separadamente." });
        this.dicaMarcar.hide();
      }
    } else {
      this.linhasItens = null;
      this.areaVerso = resposta;
    }

    this.acoes = contentEl.createDiv("ct-acoes");
    this.mostrarBotaoRevelar();
    // O Obsidian foca o primeiro botão do modal, o que deixa um anel de foco sem sentido aqui
    window.setTimeout(() => this.contentEl.contains(document.activeElement) && document.activeElement.blur(), 0);
  }

  /**
   * Contexto acima da pergunta: o caminho (seções e bullets acima) em letra pequena e o pai direto
   * em destaque, para perguntas curtas como "O que faz?" fazerem sentido sozinhas.
   */
  mostrarContexto(palco, c) {
    // Sem repetições seguidas e sem o título igual ao nome da nota, que já está no topo
    const partes = c.contexto.filter((p, i, todos) => p && p !== todos[i - 1] && !(i === 0 && p === c.arquivo.basename));
    if (!partes.length) return;
    const pai = partes.pop();
    const caixa = palco.createDiv("ct-contexto-cartao");
    if (partes.length) {
      const caminho = caixa.createDiv({ cls: "ct-caminho", attr: { "aria-label": partes.join(" › ") } });
      const encaixar = (n) => caminho.setText((n < partes.length ? "… › " : "") + partes.slice(partes.length - n).join(" › "));
      encaixar(partes.length);
      // Caminho longo: corta pelo começo, para o trecho mais perto da pergunta continuar visível
      window.requestAnimationFrame(() => {
        for (let n = partes.length - 1; n >= 1 && caminho.scrollWidth > caminho.clientWidth; n--) encaixar(n);
      });
    }
    caixa.createDiv({ cls: "ct-pai", text: pai });
  }

  mostrarBotaoRevelar() {
    this.acoes.empty();
    const lista = !!this.linhasItens;
    const botao = this.acoes.createEl("button", { cls: "ct-revelar" });
    botao.createSpan({ text: lista ? "Revelar próximo" : "Mostrar resposta" });
    botao.createEl("kbd", { text: "espaço" });
    botao.addEventListener("click", () => this.revelarProximo());
    if (lista && this.linhasItens.length > 1) {
      const todos = this.acoes.createEl("button", { cls: "ct-secundario", text: "Revelar todos" });
      todos.addEventListener("click", () => this.linhasItens.forEach((_, i) => this.revelarItem(i)));
    }
  }

  revelarProximo() {
    if (this.revelado) return;
    if (this.alvoItem) {
      const { linha, corpo, texto } = this.alvoItem;
      linha.removeClass("ct-oculto");
      corpo.empty();
      this.renderizar(texto, corpo);
      this.concluirRevelacao();
      return;
    }
    if (!this.linhasItens) {
      this.areaVerso.addClass("ct-visivel");
      this.renderizar(this.atual.verso, this.areaVerso.createDiv("ct-verso"));
      this.concluirRevelacao();
      return;
    }
    const proximo = this.linhasItens.findIndex((l) => l.linha.hasClass("ct-oculto"));
    if (proximo >= 0) this.revelarItem(proximo);
  }

  revelarItem(i) {
    const item = this.linhasItens[i];
    if (!item.linha.hasClass("ct-oculto")) return;
    item.linha.removeClass("ct-oculto");
    item.corpo.empty();
    this.renderizar(item.texto, item.corpo);
    this.revelados += 1;
    this.ultimoRevelado = i;
    this.dicaMarcar?.show();
    if (this.revelados === this.linhasItens.length) this.concluirRevelacao();
  }

  alternarEsquecido(i) {
    if (!this.podeMarcar || !this.atual) return;
    const esquecido = !this.esquecidos.has(i);
    if (esquecido) this.esquecidos.add(i);
    else this.esquecidos.delete(i);
    this.linhasItens[i].linha.toggleClass("ct-esquecido", esquecido);
  }

  concluirRevelacao() {
    this.revelado = true;
    this.mostrarAnexos(this.atual);
    this.mostrarBotoesNota();
  }

  mostrarBotoesNota() {
    this.acoes.empty();
    const c = this.atual;
    const estado = this.plugin.dados.cartoes[c.id];
    const grade = this.acoes.createDiv("ct-notas");
    for (const n of NOTAS) {
      const proximo = agendar(estado, n.valor, hojeISO(), this.plugin.config.intervaloMaximo);
      const botao = grade.createEl("button", { cls: `ct-nota ${n.classe}` });
      const titulo = botao.createDiv("ct-nota-titulo");
      titulo.createSpan({ cls: "ct-ponto" });
      titulo.createSpan({ text: n.nome });
      const rodape = botao.createDiv("ct-nota-rodape");
      rodape.createSpan({ text: this.livre ? "—" : formatarIntervalo(proximo.intervalo) });
      rodape.createEl("kbd", { text: String(n.valor) });
      botao.addEventListener("click", () => this.avaliar(n.valor));
    }
  }

  async avaliar(nota) {
    const c = this.atual;
    this.atual = null;
    const esquecidos = this.podeMarcar ? [...this.esquecidos].sort((a, b) => a - b) : [];
    if (!this.livre) await this.plugin.registrarResposta(c, nota, Date.now() - this.inicioCartao);
    const reforcos = esquecidos.length ? await this.plugin.esquecerItens(c, esquecidos) : [];
    this.contagem[nota] += 1;
    this.feitos += 1;
    this.fila.shift();
    if (nota === 1) this.fila.splice(Math.min(3, this.fila.length), 0, c);
    // Os itens esquecidos entram no fim desta sessão, se ainda não estiverem nela
    const naFila = new Set(this.fila.map((x) => x.id));
    this.fila.push(...reforcos.filter((r) => !naFila.has(r.id)));
    this.itensCriados = (this.itensCriados || 0) + reforcos.length;
    this.mostrar();
  }

  mostrarFim() {
    this.atual = null;
    this.mostrarAnexos(null);
    const fim = this.contentEl.createDiv("ct-fim");
    if (this.feitos === 0) {
      ilustrar(fim, "dormindo", "ct-il-fim");
      fim.createDiv({ cls: "ct-fim-titulo", text: "Nada para revisar agora" });
      fim.createDiv({ cls: "ct-fim-texto", text: `${this.titulo}: nenhum cartão vencido ou novo hoje.` });
      if (this.todos.length) {
        const botao = fim.createEl("button", { cls: "ct-revelar", text: `Praticar os ${this.todos.length} cartões` });
        fim.createDiv({ cls: "ct-dica", text: "sem alterar o agendamento" });
        botao.addEventListener("click", () => {
          this.fila = embaralhar([...this.todos]);
          this.total = this.fila.length;
          this.livre = true;
          this.mostrar();
        });
      }
      return;
    }
    ilustrar(fim, "feitas", "ct-il-fim");
    fim.createDiv({ cls: "ct-fim-titulo", text: "Sessão concluída" });
    const resumo = [plural(this.feitos, "resposta", "respostas")];
    if (this.itensCriados) resumo.push(`${plural(this.itensCriados, "item virou cartão", "itens viraram cartões")}`);
    fim.createDiv({ cls: "ct-fim-texto", text: resumo.join(" · ") });
    const placar = fim.createDiv("ct-fim-placar");
    for (const n of NOTAS) {
      const bloco = placar.createDiv(`ct-fim-bloco ${n.classe}`);
      bloco.createDiv({ cls: "ct-fim-numero", text: String(this.contagem[n.valor]) });
      const rotulo = bloco.createDiv("ct-nota-titulo");
      rotulo.createSpan({ cls: "ct-ponto" });
      rotulo.createSpan({ text: n.nome });
    }
    const fechar = fim.createEl("button", { cls: "ct-revelar", text: "Fechar" });
    fechar.addEventListener("click", () => this.close());
    const stats = fim.createEl("button", { cls: "ct-secundario", text: "Ver estatísticas" });
    stats.addEventListener("click", () => {
      this.close();
      this.plugin.abrirEstatisticas();
    });
  }

  abrirNota(c) {
    this.close();
    this.plugin.abrirCartao(c);
  }
}

// ------------------------------------------------------------------ anexos


/**
 * Cartão ao qual pertence a linha `numero` (1-based): a própria linha, se ela é um cartão, ou o
 * cartão de lista do qual ela é item (subindo pela indentação).
 */
function cartaoNaLinha(state, numero, tamanhoTab) {
  const doc = state.doc;
  const linha = doc.line(numero);
  const propria = analisarLinhaEditor(linha.text);
  if (propria) return { linha, c: propria };
  if (!linha.text.trim()) return null;

  let indentacao = largura(/^[ \t]*/.exec(linha.text)[0], tamanhoTab);
  for (let n = numero - 1; n >= 1 && numero - n < 300; n--) {
    const acima = doc.line(n);
    if (!acima.text.trim()) continue;
    const w = largura(/^[ \t]*/.exec(acima.text)[0], tamanhoTab);
    if (w >= indentacao) continue;
    const c = analisarLinhaEditor(acima.text);
    if (c && c.lista) return { linha: acima, c };
    if (c || w === 0) return null;
    indentacao = w;
  }
  return null;
}

function descreverLink(entrada) {
  const texto = entrada.trim();
  const interno = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(texto);
  if (interno) return { nota: interno[1].trim() };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(texto)) return { url: texto };
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(texto)) return { url: `https://${texto}` };
  return { nota: texto };
}

/** Lista de anexos de um cartão, usada no painel lateral e na revisão. */
function renderizarAnexos(plugin, el, idCartao, { caminhoNota, componente, aoRemover }) {
  for (const a of plugin.anexosDe(idCartao)) {
    const item = el.createDiv(`ct-anexo ct-anexo-tipo-${a.tipo}`);

    if (a.tipo === "imagem") {
      const arquivo = plugin.app.vault.getAbstractFileByPath(a.caminho);
      if (arquivo instanceof TFile) {
        const img = item.createEl("img", { attr: { src: plugin.app.vault.getResourcePath(arquivo), alt: arquivo.basename } });
        img.addEventListener("click", () => new ModalImagem(plugin.app, img.src).open());
      } else {
        item.createDiv({ cls: "ct-anexo-perdido", text: `Imagem não encontrada: ${a.caminho}` });
      }
    } else if (a.tipo === "link") {
      const link = item.createDiv("ct-anexo-link");
      setIcon(link.createSpan("ct-anexo-icone"), a.nota ? "file-text" : "link");
      const corpo = link.createDiv("ct-anexo-corpo");
      corpo.createDiv({ cls: "ct-anexo-titulo", text: a.titulo || a.nota || a.url });
      if (a.url) {
        let host = a.url;
        try {
          host = new URL(a.url).hostname.replace(/^www\./, "");
        } catch (_) {}
        corpo.createDiv({ cls: "ct-anexo-sub", text: host });
      }
      link.addEventListener("click", () => {
        if (a.nota) plugin.app.workspace.openLinkText(a.nota, caminhoNota || "", true);
        else window.open(a.url);
      });
    } else {
      const corpo = item.createDiv("ct-anexo-comentario");
      MarkdownRenderer.render(plugin.app, a.texto, corpo, caminhoNota || "", componente);
    }

    if (aoRemover) {
      const remover = item.createEl("button", { cls: "ct-anexo-remover clickable-icon", attr: { "aria-label": "Remover anexo" } });
      setIcon(remover, "x");
      remover.addEventListener("click", (evt) => {
        evt.stopPropagation();
        aoRemover(a);
      });
    }
  }
}

class ModalImagem extends Modal {
  constructor(app, src) {
    super(app);
    this.src = src;
  }
  onOpen() {
    this.modalEl.addClass("ct-modal-imagem");
    this.contentEl.createEl("img", { attr: { src: this.src } });
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** Modal para gerenciar os anexos de um cartão: aberto ao clicar no clipe. */
class ModalAnexos extends Modal {
  constructor(plugin, alvo) {
    super(plugin.app);
    this.plugin = plugin;
    this.alvo = alvo;
    this.formulario = null;
    this.componente = null;
    // Colar uma imagem com o modal aberto anexa ao cartão
    this.aoColar = (evt) => {
      if (evt.target.closest?.("input, textarea")) return;
      const imagens = imagensDe(evt.clipboardData);
      if (!imagens.length) return;
      evt.preventDefault();
      this.adicionarImagens(imagens);
    };
  }

  onOpen() {
    this.modalEl.addClass("ct-modal-anexos");
    this.contentEl.addClass("ct-painel-anexos");
    document.addEventListener("paste", this.aoColar);
    this.modalEl.addEventListener("dragover", (evt) => {
      evt.preventDefault();
      this.modalEl.addClass("ct-arrastando");
    });
    this.modalEl.addEventListener("dragleave", () => this.modalEl.removeClass("ct-arrastando"));
    this.modalEl.addEventListener("drop", (evt) => {
      this.modalEl.removeClass("ct-arrastando");
      const imagens = imagensDe(evt.dataTransfer);
      if (!imagens.length) return;
      evt.preventDefault();
      this.adicionarImagens(imagens);
    });
    this.renderizar();
  }

  onClose() {
    document.removeEventListener("paste", this.aoColar);
    this.componente?.unload();
    this.contentEl.empty();
  }

  renderizar() {
    this.componente?.unload();
    this.componente = new Component();
    this.componente.load();
    const el = this.contentEl;
    el.empty();
    const c = this.alvo;

    const cab = el.createDiv("ct-painel-cartao");
    cab.createDiv({ cls: "ct-painel-contexto", text: c.arquivo.basename });
    MarkdownRenderer.render(this.app, c.frente, cab.createDiv("ct-painel-frente"), c.arquivo.path, this.componente);

    const lista = el.createDiv("ct-anexos");
    if (c.id && this.plugin.anexosDe(c.id).length) {
      renderizarAnexos(this.plugin, lista, c.id, {
        caminhoNota: c.arquivo.path,
        componente: this.componente,
        aoRemover: async (a) => {
          await this.plugin.removerAnexo(c.id, a);
          this.renderizar();
        },
      });
    } else {
      lista.createDiv({ cls: "ct-painel-dica", text: "Cole (Ctrl+V) ou arraste imagens aqui" });
    }

    const acoes = el.createDiv("ct-painel-acoes");
    const botao = (icone, texto, acao) => {
      const b = acoes.createEl("button", { cls: "ct-painel-botao" });
      setIcon(b.createSpan(), icone);
      b.createSpan({ text: texto });
      b.addEventListener("click", acao);
    };
    botao("image", "Imagem", () => this.escolherImagem());
    botao("link", "Link", () => this.abrirFormulario("link"));
    botao("message-square", "Comentário", () => this.abrirFormulario("comentario"));

    if (this.formulario) this.montarFormulario(el.createDiv("ct-painel-form"));
  }

  abrirFormulario(tipo) {
    this.formulario = this.formulario === tipo ? null : tipo;
    this.renderizar();
    this.contentEl.querySelector(".ct-painel-form input, .ct-painel-form textarea")?.focus();
  }

  async salvarAnexo(anexo) {
    await this.plugin.adicionarAnexo(this.alvo, anexo);
    this.formulario = null;
    this.renderizar();
  }

  montarFormulario(form) {
    if (this.formulario === "link") {
      const endereco = form.createEl("input", { type: "text", attr: { placeholder: "https://… ou [[Nota]]" } });
      const titulo = form.createEl("input", { type: "text", attr: { placeholder: "Título (opcional)" } });
      const enviar = () => {
        if (!endereco.value.trim()) return;
        this.salvarAnexo({ tipo: "link", ...descreverLink(endereco.value), titulo: titulo.value.trim() || undefined });
      };
      for (const campo of [endereco, titulo]) {
        campo.addEventListener("keydown", (evt) => evt.key === "Enter" && enviar());
      }
      form.createEl("button", { cls: "mod-cta", text: "Salvar" }).addEventListener("click", enviar);
    } else {
      const texto = form.createEl("textarea", { attr: { placeholder: "Comentário (Ctrl+Enter salva)", rows: "4" } });
      const enviar = () => {
        if (!texto.value.trim()) return;
        this.salvarAnexo({ tipo: "comentario", texto: texto.value.trim() });
      };
      texto.addEventListener("keydown", (evt) => (evt.ctrlKey || evt.metaKey) && evt.key === "Enter" && enviar());
      form.createEl("button", { cls: "mod-cta", text: "Salvar" }).addEventListener("click", enviar);
    }
    form.createEl("button", { text: "Cancelar" }).addEventListener("click", () => {
      this.formulario = null;
      this.renderizar();
    });
  }

  escolherImagem() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", () => this.adicionarImagens([...input.files]));
    input.click();
  }

  async adicionarImagens(arquivos) {
    await this.plugin.anexarImagens(this.alvo, arquivos);
    this.renderizar();
  }
}

/** Imagens de um colar ou arrastar. Prints copiados às vezes só aparecem em `items`. */
function imagensDe(transferencia) {
  if (!transferencia) return [];
  const arquivos = [...(transferencia.files || [])].filter((f) => f.type.startsWith("image/"));
  if (arquivos.length) return arquivos;
  return [...(transferencia.items || [])]
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter(Boolean);
}

// ------------------------------------------------------------------ lições

/*
 * Uma lição é um bloco ```licao com um JSON gerado por uma IA a partir das anotações. O comando
 * "Copiar prompt para a IA criar uma lição" monta o pedido com o formato abaixo. O plugin só aceita
 * esse formato: se algum campo faltar ou estiver errado, o bloco aparece como inválido e lista os
 * problemas, em vez de abrir uma lição quebrada.
 */

const TIPOS_EXERCICIO = {
  escolha: "Escolha a resposta certa",
  vf: "Verdadeiro ou falso?",
  lacuna: "Complete a frase",
  pares: "Associe os pares",
  digitar: "Escreva a resposta",
};
const LACUNA = "___";
const CERCA = "```";
const ELOGIOS = ["Correto!", "Muito bem!", "Isso aí!", "Mandou bem!", "Perfeito!"];

const PROMPT_IA = `Crie uma lição de estudo curta e gamificada, com exercícios variados, a partir das minhas anotações, que estão no fim desta mensagem.

Responda APENAS com um bloco de código ${CERCA}licao contendo um JSON válido, sem nenhum texto antes ou depois. O formato é este:

${CERCA}licao
{
  "titulo": "Assunto curto da lição",
  "exercicios": [
    { "tipo": "escolha", "pergunta": "...", "opcoes": ["...", "...", "...", "..."], "correta": "...", "explicacao": "..." },
    { "tipo": "vf", "afirmacao": "...", "correta": true, "explicacao": "..." },
    { "tipo": "lacuna", "frase": "Uma frase com ___ no lugar do termo que falta.", "opcoes": ["...", "...", "..."], "correta": "...", "explicacao": "..." },
    { "tipo": "pares", "pergunta": "Associe cada termo à sua definição", "pares": [["termo", "definição"], ["termo", "definição"], ["termo", "definição"]] },
    { "tipo": "digitar", "pergunta": "...", "respostas": ["resposta", "outra forma aceita"], "explicacao": "..." }
  ]
}
${CERCA}

Tipos de exercício:
- escolha: 3 ou 4 opções e só uma certa. "correta" é a cópia exata de uma das opções.
- vf: uma afirmação para julgar. "correta" é true ou false, sem aspas. Misture afirmações verdadeiras e falsas.
- lacuna: "frase" tem exatamente um ___ (três sublinhados), no lugar de um termo importante. "correta" é a cópia exata de uma das opções.
- pares: de 3 a 5 pares [esquerda, direita], sem textos repetidos em cada lado.
- digitar: resposta curta, de uma a três palavras, sigla ou número. "respostas" lista as formas aceitas. Maiúsculas, acentos e um pequeno erro de digitação são tolerados.
- "explicacao" é opcional em todos: uma ou duas frases curtas, mostradas depois da resposta, dizendo por que ela está certa.

Regras da lição:
- Antes de escrever, conte quantos bullets e parágrafos com conteúdo as anotações têm e escolha a quantidade de exercícios pelo tamanho:
  - curtas (até 15): 10 exercícios;
  - médias (de 16 a 40): 20 exercícios;
  - longas (mais de 40): 40 exercícios, que é o máximo.
- Se não houver conteúdo suficiente para a quantidade sem repetir pontos, faça menos exercícios. Nunca passe de 40.
- Use pelo menos 4 tipos diferentes e vá dos mais fáceis (vf, escolha) aos mais difíceis (pares, digitar).
- Use só o que está nas anotações. Não invente fatos nem detalhes que não estejam lá.
- Cubra os pontos principais e não repita a mesma pergunta com outras palavras.
- As opções erradas devem ser plausíveis, do mesmo assunto e de tamanho parecido com a certa. Evite "todas as anteriores" e "nenhuma das anteriores".
- Escreva no mesmo idioma das anotações.
- JSON estrito: aspas duplas, sem comentários e sem vírgula sobrando. Para aspas dentro de um texto, use \\".

Como ler as anotações: a indentação dos bullets mostra a hierarquia, "Pergunta == Resposta" é uma pergunta com a sua resposta, e "Pergunta ==" seguido de bullets é uma pergunta cuja resposta é a lista.

Anotações:

`;

/** Pedido para a IA com as anotações, sem frontmatter, lições já geradas nem block ids. */
function montarPrompt(anotacoes) {
  const limpo = anotacoes
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "")
    .replace(/^[ \t]*(`{3,}|~{3,})[ \t]*licao[ \t]*\r?\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "")
    .replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm, "")
    .replace(/(\r?\n){3,}/g, "\n\n")
    .trim();
  return PROMPT_IA + limpo + "\n";
}

/** O JSON da resposta da IA, que às vezes vem cercado de texto ou num bloco ```json. */
function extrairJson(texto) {
  const cercado = /(`{3,}|~{3,})[ \t]*(?:licao|json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1/.exec(texto);
  const corpo = cercado ? cercado[2] : texto;
  const inicio = corpo.indexOf("{");
  const fim = corpo.lastIndexOf("}");
  return inicio >= 0 && fim > inicio ? corpo.slice(inicio, fim + 1) : corpo.trim();
}

/**
 * Lê e valida uma lição. Devolve { licao } só com os campos conhecidos, ou { erros } com tudo o que
 * está fora do formato.
 */
function lerLicao(texto) {
  let dados;
  try {
    dados = JSON.parse(extrairJson(texto));
  } catch (erro) {
    return { erros: [`O JSON não é válido: ${erro.message}`] };
  }
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
    return { erros: ['O conteúdo precisa ser um objeto com "titulo" e "exercicios".'] };
  }

  const erros = [];
  const textoOk = (v) => typeof v === "string" && v.trim() !== "";
  const textos = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(textoOk);
  const semRepetir = (lista) => new Set(lista.map((t) => t.toLowerCase())).size === lista.length;
  const limpar = (lista) => lista.map((t) => t.trim());

  if (!textoOk(dados.titulo)) erros.push('Falta o "titulo".');
  if (!Array.isArray(dados.exercicios) || !dados.exercicios.length) {
    erros.push('Falta a lista "exercicios".');
    return { erros };
  }
  // O prompt pede no máximo 40. A folga evita recusar uma lição boa porque a IA passou um pouco.
  if (dados.exercicios.length > 50) erros.push("A lição tem mais de 50 exercícios.");

  const exercicios = dados.exercicios.map((ex, i) => {
    const onde = `Exercício ${i + 1}${ex && textoOk(ex.tipo) ? ` (${ex.tipo})` : ""}`;
    const falha = (msg) => {
      erros.push(`${onde}: ${msg}`);
      return null;
    };
    if (!ex || typeof ex !== "object") return falha("não é um objeto.");
    const explicacao = textoOk(ex.explicacao) ? ex.explicacao.trim() : undefined;

    switch (ex.tipo) {
      case "escolha":
      case "lacuna": {
        const campo = ex.tipo === "escolha" ? "pergunta" : "frase";
        if (!textoOk(ex[campo])) return falha(`falta "${campo}".`);
        if (ex.tipo === "lacuna" && ex.frase.split(LACUNA).length !== 2) return falha(`"frase" precisa ter exatamente um ${LACUNA}.`);
        if (!textos(ex.opcoes, 2, 6)) return falha('"opcoes" precisa ser uma lista de 2 a 6 textos.');
        const opcoes = limpar(ex.opcoes);
        if (!semRepetir(opcoes)) return falha('"opcoes" tem opções repetidas.');
        if (!textoOk(ex.correta) || !opcoes.includes(ex.correta.trim())) return falha('"correta" precisa ser igual a uma das opções.');
        return { tipo: ex.tipo, [campo]: ex[campo].trim(), opcoes, correta: ex.correta.trim(), explicacao };
      }
      case "vf":
        if (!textoOk(ex.afirmacao)) return falha('falta "afirmacao".');
        if (typeof ex.correta !== "boolean") return falha('"correta" precisa ser true ou false, sem aspas.');
        return { tipo: "vf", afirmacao: ex.afirmacao.trim(), correta: ex.correta, explicacao };
      case "ordem":
        // Tipo que existiu nas primeiras versões: lições antigas continuam valendo, sem ele
        return null;
      case "pares": {
        const ok = Array.isArray(ex.pares) && ex.pares.length >= 2 && ex.pares.length <= 6 &&
          ex.pares.every((p) => Array.isArray(p) && p.length === 2 && p.every(textoOk));
        if (!ok) return falha('"pares" precisa ser uma lista de 2 a 6 pares ["esquerda", "direita"].');
        const pares = ex.pares.map(limpar);
        if (!semRepetir(pares.map((p) => p[0])) || !semRepetir(pares.map((p) => p[1]))) return falha('"pares" tem textos repetidos num dos lados.');
        return { tipo: "pares", pergunta: textoOk(ex.pergunta) ? ex.pergunta.trim() : undefined, pares, explicacao };
      }
      case "digitar":
        if (!textoOk(ex.pergunta)) return falha('falta "pergunta".');
        if (!textos(ex.respostas, 1, 10)) return falha('"respostas" precisa ser uma lista com pelo menos uma resposta.');
        return { tipo: "digitar", pergunta: ex.pergunta.trim(), respostas: limpar(ex.respostas), explicacao };
      default:
        return falha(`tipo desconhecido. Os tipos aceitos são ${Object.keys(TIPOS_EXERCICIO).join(", ")}.`);
    }
  });

  if (erros.length) return { erros };
  if (!exercicios.some(Boolean)) return { erros: ["A lição não tem nenhum exercício de um tipo aceito."] };
  return { licao: { titulo: dados.titulo.trim(), exercicios: exercicios.filter(Boolean) } };
}

/** JSON da lição com um exercício por linha, para o bloco não tomar a nota inteira. */
function formatarLicao(licao) {
  const linhas = licao.exercicios.map((ex) => `    ${JSON.stringify(ex)}`);
  return `{\n  "titulo": ${JSON.stringify(licao.titulo)},\n  "exercicios": [\n${linhas.join(",\n")}\n  ]\n}`;
}

/** Conteúdo dos blocos ```licao de uma nota. */
function blocosDeLicao(texto) {
  const blocos = [];
  const re = /^[ \t]*(`{3,}|~{3,})[ \t]*licao[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/gm;
  for (let m = re.exec(texto); m; m = re.exec(texto)) blocos.push(m[2]);
  return blocos;
}

function hashTexto(texto) {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** O progresso fica ligado ao conteúdo: se a lição for gerada de novo, ela começa do zero. */
function chaveDaLicao(licao) {
  return "l-" + hashTexto(JSON.stringify(licao));
}

function normalizarResposta(texto) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,;:!?"'()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function distancia(a, b) {
  let anterior = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(anterior[j] + 1, atual[j - 1] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    anterior = atual;
  }
  return anterior[b.length];
}

/**
 * Confere uma resposta digitada: "certo", "quase" (um erro de digitação, que conta como acerto)
 * ou "errado". Números precisam ser exatos.
 */
function conferirDigitado(resposta, aceitas) {
  const r = normalizarResposta(resposta);
  if (!r) return "errado";
  const alvos = aceitas.map(normalizarResposta);
  if (alvos.includes(r)) return "certo";
  const tolerancia = (a) => (/\d/.test(a) ? 0 : a.length >= 10 ? 2 : a.length >= 5 ? 1 : 0);
  return alvos.some((a) => distancia(r, a) <= tolerancia(a)) ? "quase" : "errado";
}

/** 2 XP por exercício acertado de primeira, mais 5 se a lição saiu sem nenhum erro. */
function xpDaLicao(total, errados) {
  return (total - errados) * 2 + (errados === 0 ? 5 : 0);
}

function estrelasDe(precisao) {
  return precisao >= 1 ? 3 : precisao >= 0.8 ? 2 : 1;
}

function desenharEstrelas(pai, quantidade, cls = "ct-estrelas") {
  const el = pai.createDiv(cls);
  for (let i = 0; i < 3; i++) {
    const estrela = el.createSpan(i < quantidade ? "ct-estrela ct-estrela-cheia" : "ct-estrela");
    estrela.style.animationDelay = `${i * 0.12}s`;
    setIcon(estrela, "star");
  }
  return el;
}

let audio = null;
/** Som curto de acerto ou de erro, gerado na hora, sem arquivo de áudio. */
function tocarSom(certo) {
  try {
    audio = audio || new AudioContext();
    const notas = certo ? [[660, 0], [880, 0.09]] : [[220, 0], [185, 0.12]];
    for (const [frequencia, atraso] of notas) {
      const osc = audio.createOscillator();
      const ganho = audio.createGain();
      osc.type = certo ? "sine" : "triangle";
      osc.frequency.value = frequencia;
      const t = audio.currentTime + atraso;
      ganho.gain.setValueAtTime(0.0001, t);
      ganho.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(ganho).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    }
  } catch (_) {}
}

/** Bloco ```licao na nota: título, estrelas e o botão de começar, ou a lista de erros do formato. */
function renderizarBlocoLicao(plugin, fonte, el, ctx) {
  const { licao, erros } = lerLicao(fonte);
  const desenhar = () => {
    el.empty();
    const caixa = el.createDiv("ct-licao-bloco");
    const cab = caixa.createDiv("ct-licao-cab");

    if (erros) {
      caixa.addClass("ct-licao-invalida");
      setIcon(cab.createSpan("ct-licao-icone"), "alert-triangle");
      const texto = cab.createDiv("ct-licao-texto");
      texto.createDiv({ cls: "ct-licao-titulo", text: "Lição fora do formato" });
      texto.createDiv({ cls: "ct-licao-sub", text: "Peça para a IA corrigir estes pontos, ou gere a lição de novo." });
      const lista = caixa.createEl("ul", { cls: "ct-licao-erros" });
      for (const e of erros.slice(0, 8)) lista.createEl("li", { text: e });
      if (erros.length > 8) lista.createEl("li", { text: `e mais ${erros.length - 8}` });
      return;
    }

    const chave = chaveDaLicao(licao);
    const progresso = plugin.dados.jogo.licoes[chave];
    setIcon(cab.createSpan("ct-licao-icone"), progresso ? "trophy" : "graduation-cap");
    const texto = cab.createDiv("ct-licao-texto");
    texto.createDiv({ cls: "ct-licao-titulo", text: licao.titulo });
    const n = plural(licao.exercicios.length, "exercício", "exercícios");
    texto.createDiv({
      cls: "ct-licao-sub",
      text: progresso ? `${n} · feita ${plural(progresso.vezes, "vez", "vezes")} · melhor ${pct(progresso.melhor)}` : `${n} · nova`,
    });
    if (progresso) {
      const estrelas = estrelasDe(progresso.melhor);
      desenharEstrelas(cab, estrelas).setAttribute("aria-label", `${estrelas} de 3 estrelas`);
    }
    const botao = cab.createEl("button", { cls: "mod-cta ct-licao-comecar", text: progresso ? "Praticar" : "Começar" });
    // No Live Preview, o clique não pode levar o cursor para dentro do bloco
    botao.addEventListener("mousedown", (evt) => evt.preventDefault());
    botao.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      new ModalLicao(plugin, licao, { chave, caminhoNota: ctx.sourcePath }).open();
    });
  };
  plugin.blocosLicao.add({ el, desenhar });
  desenhar();
}

class ModalLicao extends Modal {
  constructor(plugin, licao, { chave, caminhoNota = "" }) {
    super(plugin.app);
    this.plugin = plugin;
    this.licao = licao;
    this.chave = chave;
    this.caminhoNota = caminhoNota;
    this.componente = null;
    this.teclas = (evt) => this.aoTeclar(evt);
  }

  onOpen() {
    this.modalEl.addClass("ct-modal", "ct-modal-licao");
    document.addEventListener("keydown", this.teclas, true);
    this.comecar();
  }

  onClose() {
    this.fase = "fechado";
    document.removeEventListener("keydown", this.teclas, true);
    this.componente?.unload();
    this.contentEl.empty();
  }

  comecar() {
    this.fila = this.licao.exercicios.map((ex, indice) => ({ ex, indice }));
    this.total = this.fila.length;
    this.feitos = 0;
    this.errados = new Set();
    this.combo = 0;
    this.comboMax = 0;
    this.inicio = Date.now();
    this.mostrar();
  }

  aoTeclar(evt) {
    if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.isComposing) return;
    let tratado = true;
    if (evt.key === "Enter") {
      if (this.fase === "fim") this.close();
      else this.acaoPrincipal();
    } else if (this.fase !== "resposta" || evt.target.closest?.("input, textarea")) {
      tratado = false;
    } else if (/^[1-9]$/.test(evt.key)) {
      tratado = !!this.exercicio.tecla?.(Number(evt.key) - 1);
    } else if (evt.key === "Backspace") {
      tratado = !!this.exercicio.voltar?.();
    } else {
      tratado = false;
    }
    if (tratado) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  md(texto, el) {
    MarkdownRenderer.render(this.app, texto, el, this.caminhoNota, this.componente);
    return el;
  }

  mostrar() {
    this.componente?.unload();
    this.componente = new Component();
    this.componente.load();
    const { contentEl } = this;
    contentEl.empty();
    this.fase = "resposta";
    if (!this.fila.length) return this.mostrarFim();

    const { ex } = this.fila[0];
    const topo = contentEl.createDiv("ct-licao-topo");
    const trilho = topo.createDiv("ct-licao-progresso");
    this.cheio = trilho.createDiv("ct-licao-progresso-cheio");
    this.cheio.style.width = `${(this.feitos / this.total) * 100}%`;
    if (this.combo >= 3) {
      const chip = topo.createDiv({ cls: "ct-licao-combo", attr: { "aria-label": `${this.combo} acertos seguidos` } });
      setIcon(chip.createSpan(), "flame");
      chip.createSpan({ text: String(this.combo) });
    }

    const palco = contentEl.createDiv("ct-licao-palco");
    palco.createDiv({ cls: "ct-licao-instrucao", text: TIPOS_EXERCICIO[ex.tipo] });
    this.exercicio = {
      escolha: () => this.montarOpcoes(palco, ex.pergunta, embaralhar([...ex.opcoes]), ex.correta),
      vf: () => this.montarOpcoes(palco, ex.afirmacao, ["Verdadeiro", "Falso"], ex.correta ? "Verdadeiro" : "Falso"),
      lacuna: () => this.montarLacuna(palco, ex),
      pares: () => this.montarPares(palco, ex),
      digitar: () => this.montarDigitar(palco, ex),
    }[ex.tipo]();

    this.rodape = contentEl.createDiv("ct-licao-rodape");
    this.feedback = this.rodape.createDiv("ct-licao-feedback");
    this.feedback.hide();
    this.botao = this.rodape.createEl("button", { cls: "ct-licao-botao", text: "Verificar" });
    this.botao.addEventListener("click", () => this.acaoPrincipal());
    if (this.exercicio.automatico) this.botao.hide();
    this.atualizarBotao();
    // O Obsidian foca o primeiro botão do modal, o que deixa um anel de foco sem sentido aqui
    if (ex.tipo !== "digitar") {
      window.setTimeout(() => this.contentEl.contains(document.activeElement) && document.activeElement.blur(), 0);
    }
  }

  atualizarBotao() {
    if (this.fase === "resposta") this.botao.disabled = !this.exercicio.pronto();
  }

  acaoPrincipal() {
    if (this.fase === "resultado") this.mostrar();
    else if (this.fase === "resposta" && this.exercicio.pronto()) this.concluir(this.exercicio.conferir());
  }

  /** Mostra o resultado de um exercício e atualiza o progresso, o combo e a fila. */
  concluir({ certo, repetir = !certo, resposta, aviso, titulo }) {
    if (this.fase !== "resposta") return;
    this.fase = "resultado";
    const item = this.fila.shift();
    if (certo) {
      this.combo += 1;
      this.comboMax = Math.max(this.comboMax, this.combo);
    } else {
      this.combo = 0;
      this.errados.add(item.indice);
    }
    // Errou: o exercício volta no fim da lição, até acertar
    if (repetir) this.fila.push(item);
    else this.feitos += 1;
    this.cheio.style.width = `${(this.feitos / this.total) * 100}%`;
    if (this.plugin.config.sonsLicao) tocarSom(certo);

    this.rodape.addClass(certo ? "ct-licao-certo" : "ct-licao-errado");
    const fb = this.feedback;
    fb.show();
    const cab = fb.createDiv("ct-licao-feedback-titulo");
    setIcon(cab.createSpan(), certo ? "check-circle-2" : "x-circle");
    const elogio = ELOGIOS[Math.floor(Math.random() * ELOGIOS.length)];
    cab.createSpan({ text: titulo || (certo ? (aviso ? "Quase!" : elogio) : "Resposta certa:") });
    if (!certo && resposta) this.md(resposta, fb.createDiv("ct-licao-feedback-texto ct-licao-resposta"));
    if (aviso) fb.createDiv({ cls: "ct-licao-feedback-texto", text: aviso });
    if (item.ex.explicacao) this.md(item.ex.explicacao, fb.createDiv("ct-licao-feedback-texto ct-licao-explicacao"));
    if (repetir) fb.createDiv({ cls: "ct-licao-feedback-nota", text: "Este exercício volta no fim da lição." });

    this.botao.setText("Continuar");
    this.botao.disabled = false;
    this.botao.show();
  }

  // ---------------------------------------------------------------- tipos de exercício
  // Cada um devolve { pronto(), conferir(), tecla?(i), voltar?(), automatico? }

  /** Escolha e verdadeiro ou falso: uma lista de opções, só uma certa. */
  montarOpcoes(palco, enunciado, opcoes, correta) {
    this.md(enunciado, palco.createDiv("ct-licao-enunciado"));
    const lista = palco.createDiv(opcoes.length === 2 ? "ct-licao-opcoes ct-licao-opcoes-duas" : "ct-licao-opcoes");
    let escolhida = null;
    const escolher = (i) => {
      if (this.fase !== "resposta") return;
      escolhida = i;
      botoes.forEach((b, j) => b.toggleClass("is-selecionada", j === i));
      this.atualizarBotao();
    };
    const botoes = opcoes.map((texto, i) => {
      const b = lista.createEl("button", { cls: "ct-licao-opcao" });
      b.createEl("kbd", { text: String(i + 1) });
      this.md(texto, b.createDiv("ct-licao-opcao-texto"));
      b.addEventListener("click", () => escolher(i));
      return b;
    });
    return {
      pronto: () => escolhida !== null,
      tecla: (i) => i < opcoes.length && (escolher(i), true),
      conferir: () => {
        botoes.forEach((b, j) => {
          b.disabled = true;
          if (opcoes[j] === correta) b.addClass("is-certa");
          else if (j === escolhida) b.addClass("is-errada");
        });
        return { certo: opcoes[escolhida] === correta, resposta: correta };
      },
    };
  }

  /** Completar a lacuna da frase com uma das peças. */
  montarLacuna(palco, ex) {
    const [antes, depois] = ex.frase.split(LACUNA);
    const frase = palco.createDiv("ct-licao-enunciado ct-licao-frase");
    frase.appendText(antes);
    const vazio = frase.createSpan({ cls: "ct-licao-lacuna", text: " " });
    frase.appendText(depois);

    const banco = palco.createDiv("ct-licao-banco");
    const opcoes = embaralhar([...ex.opcoes]);
    let escolhida = null;
    const escolher = (i) => {
      if (this.fase !== "resposta") return;
      escolhida = escolhida === i ? null : i;
      pecas.forEach((p, j) => p.toggleClass("is-usada", j === escolhida));
      vazio.setText(escolhida === null ? " " : opcoes[escolhida]);
      vazio.toggleClass("is-preenchida", escolhida !== null);
      this.atualizarBotao();
    };
    const pecas = opcoes.map((texto, i) => {
      const p = banco.createEl("button", { cls: "ct-licao-peca", text: texto });
      p.addEventListener("click", () => escolher(i));
      return p;
    });
    vazio.addEventListener("click", () => escolhida !== null && escolher(escolhida));
    return {
      pronto: () => escolhida !== null,
      tecla: (i) => i < opcoes.length && (escolher(i), true),
      voltar: () => escolhida !== null && (escolher(escolhida), true),
      conferir: () => {
        const certo = opcoes[escolhida] === ex.correta;
        vazio.addClass(certo ? "is-certa" : "is-errada");
        pecas.forEach((p) => (p.disabled = true));
        return { certo, resposta: ex.frase.replace(LACUNA, `**${ex.correta}**`) };
      },
    };
  }

  /** Associar pares: cada acerto trava o par, cada erro conta, e o exercício termina sozinho. */
  montarPares(palco, ex) {
    if (ex.pergunta) this.md(ex.pergunta, palco.createDiv("ct-licao-enunciado"));
    const grade = palco.createDiv("ct-licao-pares");
    let selecionado = null;
    let acertos = 0;
    let erros = 0;
    const tocar = (lado, par, botao) => {
      if (this.fase !== "resposta" || botao.disabled) return;
      if (!selecionado || selecionado.lado === lado) {
        selecionado?.botao.removeClass("is-selecionada");
        selecionado = selecionado?.botao === botao ? null : { lado, par, botao };
        selecionado?.botao.addClass("is-selecionada");
        return;
      }
      const outro = selecionado;
      selecionado = null;
      outro.botao.removeClass("is-selecionada");
      if (outro.par === par) {
        for (const b of [outro.botao, botao]) {
          b.disabled = true;
          b.addClass("is-certa");
        }
        if (++acertos < ex.pares.length) return;
        const resultado = erros
          ? { certo: false, repetir: false, titulo: "Feito, mas com erros", aviso: `${plural(erros, "associação errada", "associações erradas")}.` }
          : { certo: true };
        window.setTimeout(() => this.concluir(resultado), 350);
      } else {
        erros += 1;
        if (this.plugin.config.sonsLicao) tocarSom(false);
        for (const b of [outro.botao, botao]) {
          b.addClass("is-errada");
          window.setTimeout(() => b.removeClass("is-errada"), 500);
        }
      }
    };
    [0, 1].forEach((lado) => {
      const coluna = grade.createDiv("ct-licao-coluna");
      const itens = embaralhar(ex.pares.map((p, par) => ({ texto: p[lado], par })));
      for (const { texto, par } of itens) {
        const b = coluna.createEl("button", { cls: "ct-licao-peca ct-licao-par", text: texto });
        b.addEventListener("click", () => tocar(lado, par, b));
      }
    });
    return { automatico: true, pronto: () => false };
  }

  /** Resposta curta digitada, tolerando acentos, maiúsculas e um erro de digitação. */
  montarDigitar(palco, ex) {
    this.md(ex.pergunta, palco.createDiv("ct-licao-enunciado"));
    const campo = palco.createEl("input", {
      type: "text",
      cls: "ct-licao-campo",
      attr: { placeholder: "Sua resposta", autocomplete: "off", spellcheck: "false" },
    });
    campo.addEventListener("input", () => this.atualizarBotao());
    window.setTimeout(() => campo.focus(), 0);
    return {
      pronto: () => campo.value.trim() !== "",
      conferir: () => {
        const r = conferirDigitado(campo.value, ex.respostas);
        campo.disabled = true;
        campo.addClass(r === "errado" ? "is-errada" : "is-certa");
        return {
          certo: r !== "errado",
          resposta: ex.respostas[0],
          aviso: r === "quase" ? `Atenção à grafia: "${ex.respostas[0]}".` : undefined,
        };
      },
    };
  }

  // ---------------------------------------------------------------- fim

  async mostrarFim() {
    this.fase = "fim";
    const errados = this.errados.size;
    const precisao = (this.total - errados) / this.total;
    const xp = xpDaLicao(this.total, errados);
    const tempo = Date.now() - this.inicio;
    const resumo = await this.plugin.registrarLicao(this.chave, this.licao.titulo, { precisao, xp });
    if (this.fase !== "fim") return;
    if (this.plugin.config.sonsLicao) tocarSom(true);

    const fim = this.contentEl.createDiv("ct-fim ct-licao-fim");
    desenharEstrelas(fim, estrelasDe(precisao), "ct-estrelas ct-estrelas-grandes");
    fim.createDiv({ cls: "ct-fim-titulo", text: errados ? "Lição concluída!" : "Lição perfeita!" });
    fim.createDiv({ cls: "ct-fim-texto", text: this.licao.titulo });

    const placar = fim.createDiv("ct-licao-placar");
    const bloco = (icone, valor, rotulo) => {
      const b = placar.createDiv("ct-fim-bloco");
      setIcon(b.createDiv("ct-licao-placar-icone"), icone);
      b.createDiv({ cls: "ct-fim-numero", text: valor });
      b.createDiv({ cls: "ct-licao-placar-rotulo", text: rotulo });
    };
    bloco("zap", `+${xp}`, "XP");
    bloco("target", pct(precisao), "precisão");
    bloco("timer", formatarTempo(tempo), "tempo");

    const meta = fim.createDiv("ct-licao-meta");
    const cab = meta.createDiv("ct-licao-meta-cab");
    const cumprida = resumo.xpHoje >= resumo.meta;
    cab.createSpan({ text: cumprida ? "Meta do dia cumprida" : "Meta do dia" });
    cab.createSpan({ cls: "ct-licao-meta-num", text: `${resumo.xpHoje} / ${resumo.meta} XP` });
    const trilho = meta.createDiv("ct-licao-progresso");
    trilho.toggleClass("is-cumprida", cumprida);
    trilho.createDiv({ cls: "ct-licao-progresso-cheio", attr: { style: `width: ${Math.min(1, resumo.xpHoje / resumo.meta) * 100}%` } });

    const extras = fim.createDiv("ct-licao-extras");
    const ofensiva = extras.createDiv("ct-licao-ofensiva");
    setIcon(ofensiva.createSpan(), "flame");
    ofensiva.createSpan({ text: `${plural(resumo.ofensiva, "dia seguido", "dias seguidos")} estudando` });
    if (this.comboMax >= 3) extras.createDiv({ cls: "ct-licao-feedback-nota", text: `Maior combo: ${this.comboMax} acertos seguidos` });

    const acoes = fim.createDiv("ct-acoes");
    const continuar = acoes.createEl("button", { cls: "ct-revelar", text: "Continuar" });
    continuar.createEl("kbd", { text: "enter" });
    continuar.addEventListener("click", () => this.close());
    acoes.createEl("button", { cls: "ct-secundario", text: "Refazer" }).addEventListener("click", () => this.comecar());
  }
}

// ------------------------------------------------------------------ ilustrações

/*
 * A Cartinha, mascote das telas: um cartão de fichário (linha vermelha no topo, pautas azuis) com
 * rosto. Os desenhos são SVG montado aqui mesmo, com as cores nas classes ct-il-* do styles.css,
 * para seguir o tema claro e o escuro. Coordenadas da Cartinha: o cartão vai de (0,0) a (56,72).
 */

const ROSTOS = {
  feliz: { olhos: "abertos", boca: "sorriso" },
  animado: { olhos: "alegres", boca: "aberta" },
  dormindo: { olhos: "fechados", boca: "o" },
  neutro: { olhos: "abertos", boca: "reta" },
  preocupado: { olhos: "abertos", boca: "ondulada" },
};

const OLHOS = {
  abertos: '<ellipse class="ct-il-tinta" cx="19" cy="33" rx="3.3" ry="4.3"/><ellipse class="ct-il-tinta" cx="37" cy="33" rx="3.3" ry="4.3"/>'
    + '<circle class="ct-il-luz" cx="20.3" cy="31.4" r="1.2"/><circle class="ct-il-luz" cx="38.3" cy="31.4" r="1.2"/>',
  alegres: '<path class="ct-il-rosto" d="M15 35 q4 -6 8 0"/><path class="ct-il-rosto" d="M33 35 q4 -6 8 0"/>',
  fechados: '<path class="ct-il-rosto" d="M15 33 q4 4 8 0"/><path class="ct-il-rosto" d="M33 33 q4 4 8 0"/>',
};

const BOCAS = {
  sorriso: '<path class="ct-il-rosto" d="M23 42 q5 5.5 10 0"/>',
  aberta: '<path class="ct-il-tinta" d="M22 41 h12 q0 9 -6 9 q-6 0 -6 -9z"/><path class="ct-il-lingua" d="M24.6 47.4 q3.4 -3.2 6.8 0 q-3.4 2.8 -6.8 0z"/>',
  o: '<ellipse class="ct-il-tinta" cx="28" cy="44" rx="2.3" ry="2"/>',
  reta: '<path class="ct-il-rosto" d="M24 44 h8"/>',
  ondulada: '<path class="ct-il-rosto" d="M22.5 45 q2.75 -3 5.5 0 q2.75 3 5.5 0"/>',
};

// Fim de cada braço (mão), saindo dos lados do cartão
const BRACOS = {
  baixo: [["M1 42 q-9 5 -8 15", -7, 57], ["M55 42 q9 5 8 15", 63, 57]],
  cima: [["M1 40 q-13 -6 -10 -26", -9, 14], ["M55 40 q13 -6 10 -26", 65, 14]],
  aceno: [["M1 42 q-9 5 -8 15", -7, 57], ["M55 40 q13 -6 10 -26", 65, 14]],
};

function cartinha({ x = 0, y = 0, giro = 0, rosto = "feliz", bracos = "baixo", pernas = true, curativo = false }) {
  const r = ROSTOS[rosto];
  const membros = BRACOS[bracos].map(([d, mx, my]) =>
    `<path class="ct-il-traco ct-il-sem-fundo" d="${d}"/><circle class="ct-il-papel ct-il-traco" cx="${mx}" cy="${my}" r="3.6"/>`
  ).join("");
  const pes = pernas
    ? '<path class="ct-il-traco" d="M19 72 v8 M37 72 v8"/><ellipse class="ct-il-pe" cx="16.5" cy="81" rx="5.5" ry="3"/><ellipse class="ct-il-pe" cx="39.5" cy="81" rx="5.5" ry="3"/>'
    : "";
  const bandaid = curativo
    ? '<g transform="rotate(-28 44 43)"><rect class="ct-il-curativo ct-il-traco-fino" x="36" y="40" width="16" height="6.5" rx="3.2"/><rect class="ct-il-curativo-meio" x="41.5" y="41.2" width="5" height="4" rx="1"/></g>'
    : "";
  return `<g transform="translate(${x} ${y}) rotate(${giro} 28 40)">${membros}${pes}`
    + '<rect class="ct-il-papel ct-il-traco" x="0" y="0" width="56" height="72" rx="7"/>'
    + '<path class="ct-il-pauta-topo" d="M6 13 H50"/><path class="ct-il-pauta" d="M6 57 H50 M6 64 H50"/>'
    + '<ellipse class="ct-il-bochecha" cx="12.5" cy="41" rx="4.2" ry="2.5"/><ellipse class="ct-il-bochecha" cx="43.5" cy="41" rx="4.2" ry="2.5"/>'
    + OLHOS[ROSTOS[rosto].olhos] + BOCAS[r.boca] + bandaid + "</g>";
}

/** Verso de um cartão, colorido, para as pilhas atrás da Cartinha. */
function versoCartao(x, y, giro, cor) {
  return `<g transform="translate(${x} ${y}) rotate(${giro} 28 36)"><rect class="${cor} ct-il-traco" x="0" y="0" width="56" height="72" rx="7"/>`
    + '<text class="ct-il-texto-claro" x="28" y="45" text-anchor="middle" font-size="26">?</text></g>';
}

/** Brilho de quatro pontas. */
function brilho(x, y, t, cor = "ct-il-amarelo") {
  const q = t * 0.22;
  return `<path class="${cor} ct-il-traco-fino" d="M${x} ${y - t} Q${x + q} ${y - q} ${x + t} ${y} Q${x + q} ${y + q} ${x} ${y + t} Q${x - q} ${y + q} ${x - t} ${y} Q${x - q} ${y - q} ${x} ${y - t}Z"/>`;
}

function confetes(pecas) {
  const cores = ["ct-il-amarelo", "ct-il-azul", "ct-il-rosa", "ct-il-verde", "ct-il-roxo"];
  return pecas.map(([x, y, g], i) => `<rect class="${cores[i % cores.length]}" x="${x}" y="${y}" width="5" height="9" rx="1.5" transform="rotate(${g} ${x + 2.5} ${y + 4.5})"/>`).join("");
}

function balao(x, y, texto) {
  return `<g transform="translate(${x} ${y})"><path class="ct-il-papel ct-il-traco" d="M4 0 h26 a4 4 0 0 1 4 4 v18 a4 4 0 0 1 -4 4 h-14 l-8 7 l1 -7 h-5 a4 4 0 0 1 -4 -4 v-18 a4 4 0 0 1 4 -4z"/>`
    + `<text class="ct-il-texto" x="17" y="20" text-anchor="middle" font-size="18">${texto}</text></g>`;
}

function svgCena(largura, altura, conteudo) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${altura}">${conteudo}</svg>`;
}

const ILUSTRACOES = {
  novos: () => svgCena(180, 130,
    versoCartao(96, 22, 16, "ct-il-roxo") + versoCartao(82, 18, 7, "ct-il-azul")
    + cartinha({ x: 46, y: 26, giro: -8, rosto: "animado", bracos: "cima" })
    + brilho(24, 30, 9) + brilho(160, 22, 7, "ct-il-rosa") + brilho(166, 84, 9) + brilho(22, 98, 6, "ct-il-verde")),
  novosFeito: () => svgCena(180, 130,
    cartinha({ x: 40, y: 24, rosto: "animado", bracos: "baixo" })
    + '<circle class="ct-il-verde ct-il-traco" cx="136" cy="46" r="20"/><path class="ct-il-traco ct-il-sem-fundo ct-il-check" d="M126 46 l7 7 l13 -14"/>'
    + brilho(132, 92, 7) + brilho(22, 30, 6, "ct-il-rosa")),
  revisoes: () => svgCena(180, 130,
    versoCartao(104, 30, 12, "ct-il-amarelo")
    + cartinha({ x: 50, y: 26, giro: -4, rosto: "animado", bracos: "aceno" })
    + balao(8, 8, "!") + brilho(158, 20, 7, "ct-il-azul")),
  dormindo: () => svgCena(180, 130,
    '<ellipse class="ct-il-roxo ct-il-traco" cx="86" cy="108" rx="54" ry="13"/>'
    + cartinha({ x: 58, y: 24, rosto: "dormindo", bracos: "baixo", pernas: false })
    + '<text class="ct-il-texto-fora" x="124" y="40" font-size="20">z</text><text class="ct-il-texto-fora" x="138" y="24" font-size="15">z</text><text class="ct-il-texto-fora" x="149" y="12" font-size="11">z</text>'
    + '<path class="ct-il-amarelo ct-il-traco" d="M30 14 a14 14 0 1 0 14 22 a11 11 0 1 1 -14 -22z"/>'),
  feitas: () => svgCena(180, 130,
    cartinha({ x: 62, y: 40, rosto: "animado", bracos: "cima" })
    + '<g transform="translate(90 6)"><path class="ct-il-amarelo ct-il-traco" d="M-15 0 h30 v5 q0 17 -15 19 q-15 -2 -15 -19z"/>'
    + '<path class="ct-il-traco ct-il-sem-fundo" d="M-15 4 q-9 0 -7 8 q2 6 9 6 M15 4 q9 0 7 8 q-2 6 -9 6"/>'
    + '<path class="ct-il-amarelo ct-il-traco" d="M-3 23 h6 v6 h6 v5 h-18 v-5 h6z"/></g>'
    + confetes([[24, 30, -20], [40, 64, 30], [20, 96, 10], [140, 34, 25], [156, 70, -30], [134, 100, 15], [52, 14, 40], [128, 10, -15]])),
  nenhumaFeita: () => svgCena(180, 130,
    cartinha({ x: 62, y: 28, rosto: "neutro", bracos: "baixo" }) + balao(118, 8, "?")),
  erros: () => svgCena(90, 100, cartinha({ x: 17, y: 8, rosto: "preocupado", bracos: "baixo", curativo: true })),
  semErros: () => svgCena(90, 100,
    cartinha({ x: 17, y: 12, rosto: "feliz", bracos: "baixo" })
    + '<path class="ct-il-rosa ct-il-traco" d="M74 14 c-4 -7 -14 -3 -10 5 l10 9 l10 -9 c4 -8 -6 -12 -10 -5z"/>'),
  vazio: () => svgCena(180, 130, cartinha({ x: 62, y: 24, rosto: "feliz", bracos: "aceno" }) + brilho(40, 34, 7) + brilho(150, 90, 6, "ct-il-azul")),
  sol: () => svgCena(90, 60,
    '<g class="ct-il-traco"><path d="M56 6 v-4 M56 42 v4 M38 24 h-4 M74 24 h4 M43 11 l-3 -3 M69 11 l3 -3 M43 37 l-3 3 M69 37 l3 3"/></g>'
    + '<circle class="ct-il-amarelo ct-il-traco" cx="56" cy="24" r="12"/>'
    + '<path class="ct-il-papel ct-il-traco" d="M14 52 a9 9 0 0 1 4 -17 a12 12 0 0 1 22 -2 a9 9 0 0 1 6 19z"/>'),
};

/** Cor do gradiente dos segmentos do medidor, de azul (t = 0) a rosa (t = 1), passando por roxo. */
function corDoGradiente(t) {
  const paradas = [[91, 156, 240], [155, 124, 242], [255, 95, 162]];
  const k = Math.min(1, Math.max(0, t)) * (paradas.length - 1);
  const i = Math.min(paradas.length - 2, Math.floor(k));
  const c = paradas[i].map((v, j) => Math.round(v + (paradas[i + 1][j] - v) * (k - i)));
  return `rgb(${c.join(",")})`;
}

/**
 * Medidor de acertos: meio círculo em 25 segmentos, acesos até o valor, com a faixa ideal
 * (80% a 95%) marcada por fora, um marcador no valor e a Cartinha no meio, com o rosto conforme a
 * faixa.
 */
function svgMedidor(valor) {
  const cx = 100;
  const cy = 106;
  const raio = 78;
  const segmentos = 25;
  const ponto = (f, r) => [cx + r * Math.cos(Math.PI * (1 - f)), cy - r * Math.sin(Math.PI * (1 - f))].map((v) => v.toFixed(2));
  const arco = (f0, f1, r) => {
    const [x0, y0] = ponto(f0, r);
    const [x1, y1] = ponto(f1, r);
    return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  let s = "";
  for (let i = 0; i < segmentos; i++) {
    const d = arco(i / segmentos + 0.006, (i + 1) / segmentos - 0.006, raio);
    const aceso = valor != null && (i + 0.5) / segmentos <= valor;
    s += aceso
      ? `<path class="ct-medidor-seg" d="${d}" style="stroke:${corDoGradiente(i / (segmentos - 1))}"/>`
      : `<path class="ct-medidor-seg ct-medidor-apagado" d="${d}"/>`;
  }
  s += `<path class="ct-medidor-faixa" d="${arco(0.8, 0.95, raio + 12)}"/>`;
  if (valor != null) {
    const [px, py] = ponto(valor, raio + 10);
    const [ax, ay] = ponto(Math.max(0, valor - 0.025), raio + 21);
    const [bx, by] = ponto(Math.min(1, valor + 0.025), raio + 21);
    s += `<path class="ct-medidor-marcador" d="M${px} ${py} L${ax} ${ay} L${bx} ${by}Z"/>`;
  }
  const rosto = valor == null ? "neutro" : valor < 0.8 ? "preocupado" : valor <= 0.95 ? "animado" : "feliz";
  s += `<g transform="translate(${cx - 21} ${cy - 60}) scale(0.75)">${cartinha({ rosto, bracos: valor != null && valor >= 0.8 ? "cima" : "baixo", pernas: false })}</g>`;
  s += `<text class="ct-medidor-rotulo" x="${cx - raio}" y="${cy + 16}" text-anchor="middle">0%</text>`;
  s += `<text class="ct-medidor-rotulo" x="${cx + raio}" y="${cy + 16}" text-anchor="middle">100%</text>`;
  return svgCena(200, 126, s);
}

/** Insere um SVG em texto como elemento de verdade (não imagem), para herdar as cores do tema. */
function inserirSvg(pai, texto, cls = "") {
  const doc = new DOMParser().parseFromString(texto, "image/svg+xml");
  const svg = document.importNode(doc.documentElement, true);
  svg.setAttribute("class", `ct-il ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  pai.appendChild(svg);
  return svg;
}

function ilustrar(pai, nome, cls = "") {
  return inserirSvg(pai, ILUSTRACOES[nome](), cls);
}

// ------------------------------------------------------------------ tela de estatísticas

const VISAO_ESTATISTICAS = "cartinha-estatisticas";
const MATURIDADES = [
  { chave: "novo", nome: "Novos", classe: "ct-m1" },
  { chave: "aprendendo", nome: "Aprendendo", classe: "ct-m2" },
  { chave: "jovem", nome: "Jovens", classe: "ct-m3" },
  { chave: "maduro", nome: "Maduros", classe: "ct-m4" },
];
const PERIODOS = [[7, "7 dias"], [30, "30 dias"], [90, "90 dias"], [0, "Tudo"]];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const ICONE_COBERTURA = { ok: "check-circle-2", medio: "alert-circle", baixo: "alert-triangle" };
const ORDEM_COBERTURA = { baixo: 0, medio: 1, ok: 2 };

const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function diaDaSemana(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return DIAS_SEMANA[new Date(a, m - 1, d).getDay()];
}

/** Texto curto de um cartão para listas: a pergunta e, no item de lista, o item. */
function rotuloCartao(c) {
  const item = c.itemAlvo != null ? ` › ${textoDoContexto(c.itens[c.itemAlvo])}` : "";
  return textoDoContexto(c.frente) + item;
}

function formatarData(iso) {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MESES[m - 1]}`;
}

function formatarTempo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

function pct(x) {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

function plural(n, um, varios) {
  return `${n} ${n === 1 ? um : varios}`;
}

class VisaoEstatisticas extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.periodo = 30;
  }

  getViewType() {
    return VISAO_ESTATISTICAS;
  }

  getDisplayText() {
    return "Estatísticas dos flashcards";
  }

  getIcon() {
    return "bar-chart-2";
  }

  async onOpen() {
    this.contentEl.addClass("ct-stats");
    this.dica = document.body.createDiv("ct-dica-flutuante");
    this.dica.hide();
    await this.renderizar();
  }

  async onClose() {
    this.dica?.remove();
  }

  async renderizar() {
    if (this.renderizando) {
      this.pendente = true;
      return;
    }
    this.renderizando = true;
    try {
      const e = await this.plugin.coletarEstatisticas(this.periodo);
      const rolagem = this.contentEl.scrollTop;
      this.dica.hide();
      this.contentEl.empty();
      this.montar(this.contentEl.createDiv("ct-stats-corpo"), e);
      this.contentEl.scrollTop = rolagem;
    } finally {
      this.renderizando = false;
      if (this.pendente) {
        this.pendente = false;
        this.renderizar();
      }
    }
  }

  montar(el, e) {
    const topo = el.createDiv("ct-stats-topo");
    const titulo = topo.createDiv();
    titulo.createEl("h2", { text: "Flashcards" });
    if (!e.total) {
      const vazio = el.createDiv("ct-vazio");
      ilustrar(vazio, "vazio", "ct-il-vazio");
      vazio.createDiv({ text: "Nenhum cartão ainda. Escreva um bullet como \"Pergunta == Resposta\" para começar." });
      return;
    }
    titulo.createDiv({ cls: "ct-sub", text: `${plural(e.total, "cartão", "cartões")} em ${plural(e.porNota.length, "nota", "notas")}` });

    // O que fazer agora
    let grade = el.createDiv("ct-grade ct-grade-3");
    this.painelNovos(grade, e);
    this.painelRevisoes(grade, e);
    this.painelProximos(grade, e);

    grade = el.createDiv("ct-grade ct-grade-2");
    this.painelSequencia(grade, e);
    this.painelFeitasHoje(grade, e);

    grade = el.createDiv("ct-grade ct-grade-2");
    this.painelErros(grade, e);
    this.painelAcertos(grade, e);

    grade = el.createDiv("ct-grade ct-grade-2");
    let p = this.painel(grade, "Cartões", { icone: "layers", extra: `${pct(e.contagem.maduro / e.total)} maduros` });
    this.barraEmpilhada(p, MATURIDADES.map((m) => ({ nome: m.nome, valor: e.contagem[m.chave], classe: m.classe })));
    p = this.painel(grade, "Próximos 30 dias", { icone: "calendar-days" });
    this.colunas(p, e.previsao.map((v, i) => ({
      valor: v,
      rotulo: i === 0 ? "hoje" : i === 1 ? "amanhã" : `em ${i} dias`,
      eixo: i === 0 ? "hoje" : i % 7 === 0 ? `+${i}d` : "",
    })), ["revisão prevista", "revisões previstas"]);

    p = this.painel(el, "Atividade", { icone: "calendar" });
    this.mapaDeCalor(p, e.mapa);

    p = this.painel(el, "Histórico", {
      icone: "history",
      acao: (cab) => {
        const filtro = cab.createDiv("ct-filtro");
        for (const [dias, nome] of PERIODOS) {
          const b = filtro.createEl("button", { text: nome });
          if (dias === this.periodo) b.addClass("is-active");
          b.addEventListener("click", () => {
            this.periodo = dias;
            this.renderizar();
          });
        }
      },
    });
    const n = e.atividade.length;
    const passo = Math.max(1, Math.ceil(n / 6));
    this.colunas(p, e.atividade.map((d, i) => ({
      valor: d.total,
      rotulo: formatarData(d.dia),
      detalhe: d.erros ? `${d.erros} com Errei` : null,
      eixo: (n - 1 - i) % passo === 0 ? (i === n - 1 ? "hoje" : formatarData(d.dia)) : "",
    })), ["revisão", "revisões"]);
    const respostas = e.respostas.reduce((a, b) => a + b, 0);
    const rodape = p.createDiv("ct-painel-rodape ct-rodape-dados");
    this.miniDado(rodape, "Revisões", String(e.revisoesPeriodo));
    this.miniDado(rodape, "Acertos", respostas ? pct((respostas - e.respostas[0]) / respostas) : "—");
    this.miniDado(rodape, "Tempo por cartão", e.tempoMedio ? formatarTempo(e.tempoMedio) : "—");
    this.miniDado(rodape, "Dias estudados", `${e.atividade.filter((d) => d.total).length} de ${n}`);

    p = this.painel(el, "Notas", { icone: "file-text", extra: plural(e.porNota.length, "nota", "notas") });
    this.listaNotas(p, e.porNota);

    if (e.dificeis.length) {
      p = this.painel(el, "Cartões mais difíceis", { icone: "alert-triangle" });
      this.listaDificeis(p, e.dificeis);
    }
  }

  // ---------------------------------------------------------------- painéis

  /** Caixa da grade, com título opcional, um texto ao lado do título e controles à direita. */
  painel(pai, titulo, { icone, extra, acao } = {}) {
    const p = pai.createDiv("ct-painel");
    if (!titulo) return p;
    const cab = p.createDiv("ct-painel-cab");
    const t = cab.createDiv("ct-painel-titulo");
    if (icone) setIcon(t.createSpan("ct-painel-icone"), icone);
    t.createSpan({ text: titulo });
    if (extra) t.createSpan({ cls: "ct-painel-extra", text: extra });
    if (acao) acao(cab);
    return p;
  }

  /** Painel grande com desenho, título, selo com um número e um botão, como "Novos" e "Revisões". */
  painelAcao(pai, { ilustracao, rotulo, titulo, selo, seloOk, texto, botao, aoClicar }) {
    const p = pai.createDiv("ct-painel ct-painel-acao");
    ilustrar(p, ilustracao, "ct-il-acao");
    const corpo = p.createDiv("ct-acao-corpo");
    corpo.createDiv({ cls: "ct-painel-rotulo", text: rotulo });
    const linha = corpo.createDiv("ct-acao-titulo");
    linha.createSpan({ text: titulo });
    linha.createSpan({ cls: seloOk ? "ct-selo ct-selo-ok" : "ct-selo", text: selo });
    corpo.createDiv({ cls: "ct-acao-texto", text: texto });
    if (botao) corpo.createEl("button", { cls: "mod-cta ct-acao-botao", text: botao }).addEventListener("click", aoClicar);
  }

  painelNovos(pai, e) {
    const n = e.novosDisponiveis;
    let texto;
    if (n) {
      const resto = e.contagem.novo - n;
      texto = `${plural(n, "cartão novo liberado", "cartões novos liberados")} hoje.${resto > 0 ? ` Outros ${resto} entram nos próximos dias.` : ""}`;
    } else if (e.contagem.novo) {
      texto = `Você já estudou os ${e.novosHoje} novos de hoje. Faça as revisões e volte amanhã para mais.`;
    } else {
      texto = "Todos os cartões já foram estudados. Escreva mais bullets com == para ganhar novos.";
    }
    this.painelAcao(pai, {
      ilustracao: n ? "novos" : "novosFeito",
      rotulo: "Hoje",
      titulo: "Novos",
      selo: n ? String(n) : e.contagem.novo ? "Feito!" : "0",
      seloOk: !n && !!e.contagem.novo,
      texto,
      botao: n ? "Estudar" : null,
      aoClicar: () => this.plugin.revisar(null),
    });
  }

  painelRevisoes(pai, e) {
    this.painelAcao(pai, {
      ilustracao: e.vencidos ? "revisoes" : "dormindo",
      rotulo: "Agora",
      titulo: "Revisões",
      selo: String(e.vencidos),
      texto: e.vencidos
        ? `${plural(e.vencidos, "cartão espera", "cartões esperam")} revisão. Revisar no dia certo é o que fixa a memória.`
        : "Não há revisões para fazer agora.",
      botao: e.vencidos ? "Revisar" : null,
      aoClicar: () => this.plugin.revisar(null),
    });
  }

  /** Amanhã em destaque e os próximos dias em barras, com o total que acumula se não revisar. */
  painelProximos(pai, e) {
    const p = pai.createDiv("ct-painel ct-proximos");
    const cab = p.createDiv("ct-proximos-cab");
    const textoCab = cab.createDiv();
    textoCab.createDiv({ cls: "ct-painel-rotulo", text: "Amanhã" });
    textoCab.createDiv({ cls: "ct-proximos-total", text: `+${plural(e.previsao[1], "cartão", "cartões")}` });
    ilustrar(cab, "sol", "ct-il-sol");
    const lista = p.createDiv("ct-proximos-lista");
    const dias = e.previsao.slice(0, 5);
    const max = Math.max(1, ...dias);
    const hoje = hojeISO();
    let acumulado = 0;
    dias.forEach((n, i) => {
      acumulado += n;
      const dia = somarDias(hoje, i);
      const linha = lista.createDiv("ct-proximos-linha");
      linha.createSpan({ cls: "ct-proximos-dia", text: i === 0 ? "hoje" : diaDaSemana(dia) });
      const barra = linha.createDiv("ct-proximos-trilho").createDiv("ct-proximos-barra");
      barra.style.width = n ? `${Math.max(3, (n / max) * 100)}%` : "0";
      linha.createSpan({ cls: n ? "ct-proximos-mais is-ativo" : "ct-proximos-mais", text: `+${n}` });
      linha.createSpan({ cls: "ct-proximos-acumulado", text: String(acumulado) });
      this.ligarDica(linha, plural(n, "cartão vence", "cartões vencem"), `${i === 0 ? "hoje" : formatarData(dia)} · ${acumulado} acumulados se não revisar`);
    });
  }

  painelSequencia(pai, e) {
    const p = pai.createDiv("ct-painel");
    const topo = p.createDiv("ct-sequencia");
    const esq = topo.createDiv();
    esq.createDiv({ cls: "ct-painel-rotulo", text: "Sequência" });
    const num = esq.createDiv("ct-numero-grande");
    num.createSpan({ text: String(e.sequencia) });
    num.createSpan({ cls: "ct-numero-unidade", text: e.sequencia === 1 ? "dia" : "dias" });
    const semana = topo.createDiv("ct-semana");
    for (const d of e.semana) {
      const col = semana.createDiv("ct-semana-dia");
      col.toggleClass("is-hoje", d.hoje);
      col.toggleClass("is-feito", d.estudou);
      col.createDiv({ cls: "ct-semana-nome", text: d.hoje ? "hoje" : diaDaSemana(d.dia) });
      const marca = col.createDiv("ct-semana-marca");
      if (d.estudou) setIcon(marca, "check");
      this.ligarDica(col, d.estudou ? "estudou" : "sem estudo", formatarData(d.dia));
    }
    const rodape = p.createDiv("ct-painel-rodape ct-rodape-dados");
    this.miniDado(rodape, "Melhor sequência", plural(e.melhorSequencia, "dia", "dias"));
    this.miniDado(rodape, "XP em lições hoje", String(e.xpHoje));
  }

  painelFeitasHoje(pai, e) {
    const p = pai.createDiv("ct-painel");
    const corpo = p.createDiv("ct-feitas");
    ilustrar(corpo, e.hoje.total ? "feitas" : "nenhumaFeita", "ct-il-feitas");
    const t = corpo.createDiv();
    t.createDiv({ cls: "ct-numero-grande", text: String(e.hoje.total) });
    t.createDiv({ cls: "ct-feitas-titulo", text: e.hoje.total === 1 ? "Revisão feita" : "Revisões feitas" });
    t.createDiv({ cls: "ct-sub", text: e.hoje.tempo ? `hoje · ${formatarTempo(e.hoje.tempo)}` : "hoje" });
    const rodape = p.createDiv("ct-painel-rodape ct-rodape-centro");
    rodape.createSpan({ text: "Ontem: " });
    rodape.createEl("strong", { text: plural(e.ontem, "revisão", "revisões") });
  }

  painelErros(pai, e) {
    const n = e.errosRecentes.length;
    const p = this.painel(pai, "Erros recentes", {
      icone: "rotate-ccw",
      extra: "últimas 24 horas",
      acao: n ? (cab) => {
        const b = cab.createEl("button", { cls: "ct-botao-pequeno", text: "Estudar de novo", attr: { "aria-label": "Revisa só estes cartões, sem mudar o agendamento" } });
        b.addEventListener("click", () => this.plugin.praticar(e.errosRecentes, "Erros recentes"));
      } : null,
    });
    if (!n) {
      const vazio = p.createDiv("ct-erros-vazio");
      ilustrar(vazio, "semErros", "ct-il-erros");
      vazio.createDiv({ text: "Nenhum erro recente. Mandou bem!" });
      return;
    }
    const chips = p.createDiv("ct-erros-chips");
    for (const c of e.errosRecentes.slice(0, 8)) {
      const chip = chips.createEl("button", { cls: "ct-erro-chip", text: rotuloCartao(c), attr: { "aria-label": `${rotuloCartao(c)} · ${c.arquivo.basename}` } });
      chip.addEventListener("click", () => this.plugin.abrirCartao(c));
    }
    if (n > 8) chips.createSpan({ cls: "ct-erro-chip ct-erro-mais", text: `+${n - 8}` });
  }

  /** Medidor de acertos dos últimos 7 dias, com a comparação e o uso de cada botão. */
  painelAcertos(pai, e) {
    const a = e.acertos;
    const p = this.painel(pai, "Acertos", { icone: "target", extra: "últimos 7 dias" });
    const corpo = p.createDiv("ct-acertos");
    const medidor = corpo.createDiv("ct-medidor");
    inserirSvg(medidor, svgMedidor(a.atual), "ct-medidor-svg");
    const [texto, nivel] = a.atual == null ? ["sem revisões ainda", ""]
      : a.atual < 0.8 ? ["abaixo da faixa ideal", "baixo"]
      : a.atual <= 0.95 ? ["na faixa ideal", "ok"]
      : ["acima da faixa ideal", "alto"];
    medidor.createDiv({
      cls: `ct-medidor-texto ${nivel ? `ct-medidor-${nivel}` : ""}`,
      text: texto,
      attr: { "aria-label": "A faixa ideal, marcada em verde, é acertar entre 80% e 95%. Acima disso, os cartões podem estar fáceis demais; abaixo, vale revisar com mais frequência." },
    });

    const lado = corpo.createDiv("ct-acertos-lado");
    const linha = lado.createDiv("ct-acertos-numero");
    linha.createSpan({ cls: "ct-numero-grande", text: pct(a.atual) });
    if (a.atual != null && a.anterior != null) {
      const diferenca = Math.round((a.atual - a.anterior) * 100);
      const cls = diferenca > 0 ? "ct-variacao ct-variacao-sobe" : diferenca < 0 ? "ct-variacao ct-variacao-desce" : "ct-variacao";
      linha.createSpan({ cls, text: diferenca > 0 ? `▲ ${diferenca}` : diferenca < 0 ? `▼ ${-diferenca}` : "=", attr: { "aria-label": "Pontos em relação à semana anterior" } });
    }
    lado.createDiv({ cls: "ct-sub", text: a.total ? `${a.total - a.respostas[0]} de ${plural(a.total, "resposta", "respostas")} sem Errei` : "nenhuma resposta nos últimos 7 dias" });
    const botoes = lado.createDiv("ct-acertos-botoes");
    NOTAS.forEach((nota, i) => {
      const b = botoes.createDiv(`ct-acertos-botao ${nota.classe}`);
      b.createSpan({ cls: "ct-ponto" });
      b.createSpan({ cls: "ct-acertos-botao-nome", text: nota.nome });
      b.createSpan({ cls: "ct-acertos-botao-valor", text: String(a.respostas[i]) });
    });

    const rodape = p.createDiv("ct-painel-rodape ct-rodape-centro");
    rodape.createSpan({ text: "Semana anterior: " });
    rodape.createEl("strong", { text: pct(a.anterior) });
  }

  miniDado(pai, rotulo, valor) {
    const d = pai.createDiv("ct-mini-dado");
    d.createDiv({ cls: "ct-sub", text: rotulo });
    d.createDiv({ cls: "ct-mini-valor", text: valor });
  }

  // ---------------------------------------------------------------- peças

  ligarDica(el, valor, rotulo) {
    el.tabIndex = 0;
    const mostrar = () => {
      this.dica.empty();
      this.dica.createDiv({ cls: "ct-dica-valor", text: valor });
      if (rotulo) this.dica.createDiv({ cls: "ct-dica-rotulo", text: rotulo });
      this.dica.show();
      const r = el.getBoundingClientRect();
      this.dica.style.left = `${r.left + r.width / 2}px`;
      this.dica.style.top = `${r.top - 6}px`;
    };
    const esconder = () => this.dica.hide();
    el.addEventListener("pointerenter", mostrar);
    el.addEventListener("pointerleave", esconder);
    el.addEventListener("focus", mostrar);
    el.addEventListener("blur", esconder);
  }

  /** Barra horizontal de partes de um todo, com legenda que também mostra os números. */
  barraEmpilhada(pai, partes, { legenda = true } = {}) {
    const total = partes.reduce((s, p) => s + p.valor, 0);
    const barra = pai.createDiv(legenda ? "ct-empilhada" : "ct-empilhada ct-empilhada-mini");
    if (!total) barra.addClass("ct-empilhada-vazia");
    for (const p of partes) {
      if (!p.valor) continue;
      const seg = barra.createDiv(`ct-segmento ${p.classe}`);
      seg.style.flexGrow = String(p.valor);
      this.ligarDica(seg, String(p.valor), `${p.nome} · ${pct(p.valor / total)}`);
    }
    if (!legenda) return;
    const leg = pai.createDiv("ct-legenda");
    for (const p of partes) {
      const item = leg.createDiv("ct-legenda-item");
      item.createSpan({ cls: `ct-amostra ${p.classe}` });
      item.createSpan({ cls: "ct-legenda-nome", text: p.nome });
      item.createSpan({ cls: "ct-legenda-valor", text: String(p.valor) });
      if (total) item.createSpan({ cls: "ct-legenda-pct", text: pct(p.valor / total) });
    }
  }

  /** Colunas verticais de uma série só, com o valor ao passar o mouse ou focar. */
  colunas(pai, pontos, [um, varios]) {
    const max = Math.max(1, ...pontos.map((p) => p.valor));
    const graf = pai.createDiv("ct-colunas");
    const area = graf.createDiv("ct-colunas-area");
    area.createDiv({ cls: "ct-eixo-max", text: String(max) });
    const barras = area.createDiv("ct-colunas-barras");
    for (const p of pontos) {
      const slot = barras.createDiv("ct-coluna");
      const barra = slot.createDiv("ct-coluna-barra");
      barra.style.height = p.valor ? `${Math.max(3, (p.valor / max) * 100)}%` : "0";
      this.ligarDica(slot, `${p.valor} ${p.valor === 1 ? um : varios}`, [p.rotulo, p.detalhe].filter(Boolean).join(" · "));
    }
    const eixo = graf.createDiv("ct-colunas-eixo");
    for (const p of pontos) eixo.createDiv({ cls: "ct-eixo-rotulo" }).createSpan({ text: p.eixo || "" });
  }

  mapaDeCalor(pai, mapa) {
    const max = Math.max(1, ...mapa.map((d) => d.total));
    const nivel = (t) => (t === 0 ? 0 : Math.min(4, Math.ceil((t / max) * 4)));
    const semanas = Math.ceil(mapa.length / 7);
    const caixa = pai.createDiv("ct-calor");
    const meses = caixa.createDiv("ct-calor-meses");
    const grade = caixa.createDiv("ct-calor-grade");
    meses.style.gridTemplateColumns = grade.style.gridTemplateColumns = `repeat(${semanas}, minmax(0, 1fr))`;

    // Um rótulo por mês, na semana em que ele começa. Se dois ficam colados (mês parcial no
    // início do mapa), o primeiro sai para não sobrepor.
    const rotulos = [];
    for (let w = 0; w < semanas; w++) {
      const mes = Number(mapa[w * 7].dia.split("-")[1]);
      if (!rotulos.length || rotulos[rotulos.length - 1].mes !== mes) rotulos.push({ w, mes });
    }
    rotulos.forEach((r, i) => {
      const proximo = rotulos[i + 1];
      if ((proximo && proximo.w - r.w < 3) || r.w > semanas - 3) return;
      const el = meses.createSpan({ text: MESES[r.mes - 1] });
      el.style.gridColumn = `${r.w + 1} / span 3`;
    });
    for (const d of mapa) {
      const cel = grade.createDiv(`ct-celula ct-calor-${nivel(d.total)}`);
      this.ligarDica(cel, plural(d.total, "revisão", "revisões"), formatarData(d.dia));
    }

    const leg = caixa.createDiv("ct-calor-legenda");
    leg.createSpan({ text: "menos" });
    for (let i = 0; i <= 4; i++) leg.createDiv(`ct-celula ct-calor-${i}`);
    leg.createSpan({ text: "mais" });
  }

  /**
   * Notas com cartões, primeiro as que pedem ação: cartões para revisar, depois pouca cobertura.
   * Cada uma mostra só a maturidade e um status.
   */
  listaNotas(pai, notas) {
    const ordenadas = [...notas].sort((a, b) =>
      b.vencidos - a.vencidos ||
      ORDEM_COBERTURA[a.cobertura.nivel] - ORDEM_COBERTURA[b.cobertura.nivel] ||
      a.arquivo.basename.localeCompare(b.arquivo.basename)
    );
    const lista = pai.createDiv("ct-notas-lista");
    const desenhar = (todas) => {
      lista.empty();
      for (const n of todas ? ordenadas : ordenadas.slice(0, 6)) {
        const linha = lista.createDiv("ct-nota-linha");
        linha.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(n.arquivo));
        const nome = linha.createDiv("ct-nota-nome");
        nome.createDiv({ cls: "ct-nota-titulo-texto", text: n.arquivo.basename });
        const pasta = n.arquivo.parent?.path;
        nome.createDiv({ cls: "ct-sub", text: pasta && pasta !== "/" ? pasta : "raiz do vault" });

        const cartoes = linha.createDiv("ct-nota-cartoes");
        cartoes.createDiv({ cls: "ct-sub", text: plural(n.total, "cartão", "cartões") });
        this.barraEmpilhada(cartoes, MATURIDADES.map((m) => ({ nome: m.nome, valor: n.contagem[m.chave], classe: m.classe })), { legenda: false });

        let status;
        if (n.vencidos) status = ["ct-status-revisar", "layers", `${n.vencidos} para revisar`];
        else if (n.cobertura.nivel !== "ok") {
          status = [`ct-status-${n.cobertura.nivel}`, ICONE_COBERTURA[n.cobertura.nivel], n.cobertura.texto];
        } else status = ["ct-status-ok", "check-circle-2", "Em dia"];
        const chip = linha.createDiv(`ct-status ${status[0]}`);
        setIcon(chip.createSpan("ct-status-icone"), status[1]);
        chip.createSpan({ text: status[2] });
        if (n.semCartao && n.cobertura.nivel !== "ok") {
          chip.setAttribute("aria-label", `${plural(n.semCartao, "trecho", "trechos")} sem card · ${pct(n.cobertura.proporcao)} coberto`);
        }

        const botao = linha.createEl("button", { cls: "clickable-icon ct-nota-revisar", attr: { "aria-label": "Revisar esta nota" } });
        setIcon(botao, "play");
        botao.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.plugin.revisar(n.arquivo);
        });
      }
      if (ordenadas.length > 6) {
        const mais = lista.createEl("button", { cls: "ct-botao-pequeno ct-notas-mais", text: todas ? "Mostrar menos" : `Mostrar todas (${ordenadas.length})` });
        mais.addEventListener("click", () => desenhar(!todas));
      }
    };
    desenhar(false);
  }

  listaDificeis(pai, dificeis) {
    const lista = pai.createDiv("ct-dificeis");
    for (const { cartao, estado } of dificeis) {
      const item = lista.createDiv("ct-dificil-item");
      const texto = item.createDiv("ct-dificil-texto");
      texto.createDiv({ cls: "ct-dificil-frente", text: rotuloCartao(cartao) });
      texto.createDiv({ cls: "ct-sub", text: `${cartao.arquivo.basename} · próxima revisão ${formatarData(estado.vencimento)}` });
      item.createDiv({ cls: "ct-dificil-erros", text: plural(estado.lapsos, "erro", "erros") });
      item.addEventListener("click", () => this.plugin.abrirCartao(cartao));
    }
  }
}

// ------------------------------------------------------------------ grafo

/*
 * No grafo global, o Obsidian dimensiona cada nó pelo número de links. Opcionalmente, o plugin troca
 * isso pelo nível na hierarquia: a pasta (raiz do vault maior) ou a distância em links até uma nota
 * raiz. O renderizador do grafo já aceita um mapa `weights` (é o que o grafo local usa), e o tamanho
 * do nó é max(8, min(3·√(peso+1), 30)).
 */

const TAMANHO_MIN = 8;
const TAMANHO_MAX = 26;

/** Peso que dá um nó de tamanho proporcional ao nível: o nível 0 fica com o maior. */
function pesoPorNivel(nivel, nivelMax) {
  const fator = nivelMax > 0 ? 1 - nivel / nivelMax : 1;
  const tamanho = TAMANHO_MIN + (TAMANHO_MAX - TAMANHO_MIN) * fator;
  return Math.max(0, (tamanho / 3) ** 2 - 1);
}

/**
 * Pesos dos nós do grafo. Em "pasta", o nível é a profundidade da pasta. Em "raiz", é a distância
 * em links (nos dois sentidos) até a nota `raiz`. Tags, links sem nota e notas sem caminho até a
 * raiz ficam com o tamanho mínimo.
 */
function pesosDoGrafo(nos, modo, raiz) {
  const niveis = {};
  const ehNota = (id) => nos[id] && nos[id].type !== "tag" && nos[id].type !== "unresolved";
  if (modo === "pasta") {
    for (const id in nos) if (ehNota(id)) niveis[id] = id.split("/").length - 1;
  } else if (modo === "raiz" && ehNota(raiz)) {
    const vizinhos = {};
    for (const id in nos) {
      for (const alvo in nos[id].links) {
        (vizinhos[id] = vizinhos[id] || []).push(alvo);
        (vizinhos[alvo] = vizinhos[alvo] || []).push(id);
      }
    }
    niveis[raiz] = 0;
    const fila = [raiz];
    for (let i = 0; i < fila.length; i++) {
      for (const v of vizinhos[fila[i]] || []) {
        if (v in niveis || !ehNota(v)) continue;
        niveis[v] = niveis[fila[i]] + 1;
        fila.push(v);
      }
    }
  }
  let nivelMax = 0;
  for (const id in niveis) nivelMax = Math.max(nivelMax, niveis[id]);
  const pesos = {};
  for (const id in nos) pesos[id] = id in niveis ? pesoPorNivel(niveis[id], nivelMax) : 0;
  return pesos;
}

function embaralhar(lista) {
  for (let i = lista.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lista[i], lista[j]] = [lista[j], lista[i]];
  }
  return lista;
}

// ------------------------------------------------------------------ plugin

module.exports = class Cartinha extends Plugin {
  async onload() {
    const salvo = (await this.loadData()) || {};
    this.config = Object.assign({}, PADRAO, salvo.config);
    this.dados = {
      cartoes: salvo.cartoes || {},
      novos: salvo.novos || { dia: "", n: 0 },
      historico: salvo.historico || [],
      anexos: salvo.anexos || {},
      jogo: Object.assign({ xp: 0, dias: {}, licoes: {} }, salvo.jogo),
      migrado: !!salvo.migrado,
    };
    this.cache = new Map();

    // Lições geradas por IA: o bloco ```licao vira um cartão com o botão de começar
    this.blocosLicao = new Set();
    this.registerMarkdownCodeBlockProcessor("licao", (fonte, el, ctx) => renderizarBlocoLicao(this, fonte, el, ctx));
    this.addCommand({
      id: "copiar-prompt-licao",
      name: "Copiar prompt para a IA criar uma lição",
      editorCallback: (editor) => this.copiarPromptDoEditor(editor),
    });
    // Também no clique direito, na nota do explorador de arquivos e dentro do editor
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, alvo) => {
        if (!(alvo instanceof TFile) || alvo.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Copiar para a IA")
            .setIcon("graduation-cap")
            .onClick(async () => this.copiarPrompt(await this.app.vault.cachedRead(alvo), "a nota inteira"))
        );
        menu.addItem((item) => item.setTitle("Colar lição da IA").setIcon("clipboard-paste").onClick(() => this.colarLicao(alvo)));
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const temSelecao = !!editor.getSelection().trim();
        menu.addItem((item) =>
          item
            .setTitle(temSelecao ? "Copiar seleção para a IA" : "Copiar para a IA")
            .setIcon("graduation-cap")
            .onClick(() => this.copiarPromptDoEditor(editor))
        );
        if (info.file) {
          menu.addItem((item) => item.setTitle("Colar lição da IA").setIcon("clipboard-paste").onClick(() => this.colarLicao(info.file)));
        }
      })
    );
    this.addCommand({
      id: "colar-licao",
      name: "Colar lição da IA",
      editorCheckCallback: (checando, _editor, ctx) => {
        if (!ctx.file) return false;
        if (!checando) this.colarLicao(ctx.file);
        return true;
      },
    });
    this.addCommand({
      id: "licao-nota",
      name: "Fazer lição desta nota",
      checkCallback: (checando) => {
        const arquivo = this.app.workspace.getActiveFile();
        if (!arquivo || arquivo.extension !== "md") return false;
        if (!checando) this.fazerLicaoDe(arquivo);
        return true;
      },
    });

    this.registerDomEvent(document, "keydown", () => this.fecharPrevia(true));

    // Colar (ou arrastar) uma imagem com o cursor num cartão anexa a imagem ao cartão, em vez de
    // inserir ![[...]] no texto. Fora de cartões, o Obsidian segue com o comportamento normal.
    const imagemNoCartao = (evt, editor, info, transferencia, pos) => {
      if (evt.defaultPrevented || !this.config.colarNoCartao) return;
      const imagens = imagensDe(transferencia);
      const view = editor?.cm;
      if (!imagens.length || !view || !info?.file || pos == null) return;
      const alvo = this.cartaoEm(view, info.file, pos);
      if (!alvo) return;
      evt.preventDefault();
      this.anexarImagens(alvo, imagens, { avisar: true });
    };
    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor, info) =>
        imagemNoCartao(evt, editor, info, evt.clipboardData, editor?.cm?.state.selection.main.head)
      )
    );
    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, info) =>
        imagemNoCartao(evt, editor, info, evt.dataTransfer, editor?.cm?.posAtCoords({ x: evt.clientX, y: evt.clientY }))
      )
    );
    this.addCommand({
      id: "anexos",
      name: "Anexos do cartão",
      editorCheckCallback: (checando, editor, ctx) => {
        const view = editor.cm;
        const alvo = view && this.cartaoEm(view, ctx.file, view.state.selection.main.head);
        if (!alvo) return false;
        if (!checando) new ModalAnexos(this, alvo).open();
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const view = editor.cm;
        const alvo = view && this.cartaoEm(view, info.file, view.state.selection.main.head);
        if (!alvo) return;
        menu.addItem((item) => item.setTitle("Anexos do cartão").setIcon("paperclip").onClick(() => new ModalAnexos(this, alvo).open()));
      })
    );

    this.registerView(VISAO_ESTATISTICAS, (leaf) => new VisaoEstatisticas(leaf, this));
    this.addRibbonIcon("bar-chart-2", "Estatísticas dos flashcards", () => this.abrirEstatisticas());
    this.addCommand({ id: "estatisticas", name: "Abrir estatísticas", callback: () => this.abrirEstatisticas() });

    // Resumo da nota aberta: quantos cards, quantos para revisar e se ainda faltam cards nela
    this.statusNota = this.addStatusBarItem();
    this.statusNota.addClass("mod-clickable");
    this.statusNota.addEventListener("click", () => this.abrirEstatisticas());
    this.registerEvent(this.app.workspace.on("file-open", () => this.atualizarStatusNota()));

    this.registerEditorExtension([
      Prec.highest(keymap.of([{ key: "Enter", run: (view) => enterAposSeparador(this, view) || enterAntesDoId(this, view) }])),
      criarDecoracoes(this),
      criarTopicos(this),
      barraDeSelecao(this),
    ]);
    this.registerMarkdownPostProcessor((el) => {
      processarLeitura(this, el);
      topicosNaLeitura(this, el);
    });

    // Ao digitar "==", o Obsidian abre o seletor de cor do destaque, que recebe o Enter antes do
    // editor. Numa linha "Pergunta ==" a nossa sugestão abre no lugar dele e o Enter cria a lista.
    // As sugestões são testadas em ordem e as dos plugins entram no fim, por isso ela vai para o início.
    this.registerEditorSuggest(new SugestaoLista(this));
    const gerenciador = this.app.workspace.editorSuggest;
    if (Array.isArray(gerenciador?.suggests)) {
      const i = gerenciador.suggests.findIndex((s) => s instanceof SugestaoLista);
      if (i > 0) gerenciador.suggests.unshift(...gerenciador.suggests.splice(i, 1));
    }

    this.addRibbonIcon("layers", "Revisar flashcards", () => this.revisar(null));
    this.status = this.addStatusBarItem();
    this.status.addClass("mod-clickable");
    this.status.addEventListener("click", () => this.revisar(null));

    this.addCommand({ id: "revisar", name: "Revisar flashcards", callback: () => this.revisar(null) });
    this.addCommand({
      id: "revisar-nota",
      name: "Revisar flashcards desta nota",
      checkCallback: (checando) => {
        const arquivo = this.app.workspace.getActiveFile();
        if (!arquivo || arquivo.extension !== "md") return false;
        if (!checando) this.revisar(arquivo);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, alvo) => {
        if (!(alvo instanceof TFolder) && !(alvo instanceof TFile && alvo.extension === "md")) return;
        menu.addItem((item) => item.setTitle("Revisar flashcards").setIcon("layers").onClick(() => this.revisar(alvo)));
      })
    );

    const agendarStatus = debounce(() => this.atualizarStatus(), 1500);
    this.registerEvent(this.app.vault.on("modify", agendarStatus));
    this.registerEvent(this.app.vault.on("delete", (f) => { this.cache.delete(f.path); agendarStatus(); }));
    this.registerEvent(this.app.vault.on("rename", (arquivo, antigo) => {
      this.cache.delete(antigo);
      agendarStatus();
      this.acompanharRenomeacao(arquivo, antigo);
    }));
    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.migrarIdsAntigos();
      } catch (erro) {
        console.error(erro);
        new Notice("Cartinha: não foi possível atualizar os ids antigos das notas: " + erro.message);
      }
      this.atualizarStatus();
    });

    // Tamanho dos nós do grafo global pelo nível na hierarquia (opcional)
    this.app.workspace.onLayoutReady(() => this.ajustarGrafos());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.ajustarGrafos()));

    this.addSettingTab(new AbaConfiguracoes(this.app, this));
  }

  async salvar() {
    const { cartoes, novos, historico, anexos, jogo, migrado } = this.dados;
    await this.saveData({ config: this.config, cartoes, novos, historico, anexos, jogo, migrado });
  }

  /**
   * As primeiras versões usavam o prefixo "rn-" nos block ids e nas cores do marca-texto. Uma vez
   * só, troca tudo por "ct-": nas notas (ids, links para blocos e cores) e no data.json
   * (agendamento, anexos, cartões de item e histórico), sem perder o progresso.
   */
  async migrarIdsAntigos() {
    if (this.dados.migrado) return;
    const trocar = (id) => (typeof id === "string" && id.startsWith("rn-") ? "ct-" + id.slice(3) : id);
    const renomear = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [trocar(k), v]));
    this.dados.cartoes = renomear(this.dados.cartoes);
    this.dados.anexos = renomear(this.dados.anexos);
    for (const h of this.dados.historico) h[H.id] = trocar(h[H.id]);
    let notas = 0;
    for (const arquivo of this.app.vault.getMarkdownFiles()) {
      if (!/\^rn-|class="rn-mt-/.test(await this.app.vault.cachedRead(arquivo))) continue;
      await this.app.vault.process(arquivo, (texto) =>
        texto.replace(/\^rn-([A-Za-z0-9]+)/g, "^ct-$1").replace(/class="rn-mt-/g, 'class="ct-mt-')
      );
      this.cache.delete(arquivo.path);
      notas += 1;
    }
    this.dados.migrado = true;
    await this.salvar();
    if (notas) new Notice(`Cartinha: ${plural(notas, "nota atualizada", "notas atualizadas")} para o novo formato de ids.`);
  }

  // ---------------------------------------------------------------- lições

  async copiarPrompt(anotacoes, origem) {
    await navigator.clipboard.writeText(montarPrompt(anotacoes));
    new Notice(`Prompt copiado com ${origem}. Cole na IA, copie a resposta e use "Colar lição da IA".`, 8000);
  }

  /** Com texto selecionado, o prompt leva só a seleção. Sem seleção, a nota inteira. */
  copiarPromptDoEditor(editor) {
    const selecao = editor.getSelection();
    if (selecao.trim()) this.copiarPrompt(selecao, "o trecho selecionado");
    else this.copiarPrompt(editor.getValue(), "a nota inteira");
  }

  /**
   * Valida a resposta da IA na área de transferência e, se estiver no formato, acrescenta o bloco
   * no fim da nota.
   */
  async colarLicao(arquivo) {
    let texto = "";
    try {
      texto = await navigator.clipboard.readText();
    } catch (_) {}
    if (!texto.trim()) {
      new Notice("A área de transferência está vazia. Copie a resposta da IA e tente de novo.");
      return;
    }
    const { licao, erros } = lerLicao(texto);
    if (erros) {
      const lista = erros.slice(0, 5).map((e) => `• ${e}`);
      if (erros.length > 5) lista.push(`• e mais ${erros.length - 5}`);
      new Notice(`A resposta da IA está fora do formato:\n${lista.join("\n")}`, 15000);
      return;
    }
    const bloco = `${CERCA}licao\n${formatarLicao(licao)}\n${CERCA}\n`;
    await this.app.vault.process(arquivo, (atual) => {
      const corpo = atual.replace(/\s+$/, "");
      return corpo ? `${corpo}\n\n${bloco}` : bloco;
    });
    new Notice(`Lição "${licao.titulo}" adicionada no fim de "${arquivo.basename}", com ${plural(licao.exercicios.length, "exercício", "exercícios")}.`);
  }

  /** Abre a primeira lição ainda não feita da nota, ou a de menor precisão. */
  async fazerLicaoDe(arquivo) {
    const licoes = blocosDeLicao(await this.app.vault.cachedRead(arquivo))
      .map(lerLicao)
      .filter((r) => r.licao)
      .map((r) => r.licao);
    if (!licoes.length) {
      new Notice('Esta nota não tem nenhuma lição válida. Use "Copiar para a IA" no clique direito da nota para gerar uma.');
      return;
    }
    const melhor = (l) => this.dados.jogo.licoes[chaveDaLicao(l)]?.melhor ?? -1;
    const licao = licoes.reduce((a, b) => (melhor(b) < melhor(a) ? b : a));
    new ModalLicao(this, licao, { chave: chaveDaLicao(licao), caminhoNota: arquivo.path }).open();
  }

  /** Guarda o resultado de uma lição e devolve o resumo do dia para a tela final. */
  async registrarLicao(chave, titulo, { precisao, xp }) {
    const hoje = hojeISO();
    const { jogo } = this.dados;
    const antes = jogo.licoes[chave];
    jogo.xp += xp;
    jogo.dias[hoje] = (jogo.dias[hoje] || 0) + xp;
    jogo.licoes[chave] = {
      titulo,
      melhor: Math.max(Math.round(precisao * 100) / 100, antes?.melhor ?? 0),
      vezes: (antes?.vezes ?? 0) + 1,
      ultima: hoje,
    };
    await this.salvar();
    this.redesenharBlocosLicao();
    return { xpHoje: jogo.dias[hoje], meta: this.config.metaDiaria, ofensiva: this.ofensiva() };
  }

  redesenharBlocosLicao() {
    for (const bloco of this.blocosLicao) {
      if (bloco.el.isConnected) bloco.desenhar();
      else this.blocosLicao.delete(bloco);
    }
  }

  /** Dias seguidos com revisão de flashcards ou com lição. */
  ofensiva() {
    const dias = new Set(Object.keys(this.dados.jogo.dias));
    for (const h of this.dados.historico) dias.add(hojeISO(new Date(h[H.instante])));
    return sequenciaDeDias((dia) => dias.has(dia), hojeISO());
  }

  // ---------------------------------------------------------------- anexos

  anexosDe(id) {
    return (id && this.dados.anexos[id]) || [];
  }

  /** Cartão da posição `pos` (ou o cartão de lista do qual ela é item), pronto para receber anexos. */
  cartaoEm(view, arquivo, pos) {
    if (!arquivo || pos == null) return null;
    const r = cartaoNaLinha(view.state, view.state.doc.lineAt(pos).number, this.tamanhoTab());
    if (!r) return null;
    const sep = separarCartao(separarId(RE_ITEM.exec(r.linha.text)[3]).texto);
    return { view, arquivo, numeroLinha: r.linha.number, id: r.c.id, frente: sep ? sep.frente : "" };
  }

  arquivoDoEditor(view) {
    let arquivo = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.editor?.cm === view) arquivo = leaf.view.file;
    });
    return arquivo;
  }

  redesenharEditores() {
    this.app.workspace.iterateAllLeaves((leaf) => leaf.view?.editor?.cm?.dispatch({ effects: ANEXOS_MUDARAM.of(null) }));
  }

  /** Clique no clipe de uma linha: abre o modal de anexos daquele cartão. */
  abrirAnexosEm(view, pos) {
    this.fecharPrevia(true);
    const alvo = this.cartaoEm(view, this.arquivoDoEditor(view), pos);
    if (alvo) new ModalAnexos(this, alvo).open();
  }

  /** Prévia flutuante dos anexos ao passar o mouse no clipe. */
  mostrarPrevia(ancora, view) {
    clearTimeout(this.esperaPrevia);
    clearTimeout(this.esperaFechar);
    this.esperaPrevia = setTimeout(() => {
      const alvo = this.cartaoEm(view, this.arquivoDoEditor(view), view.posAtDOM(ancora));
      if (!alvo?.id || !this.anexosDe(alvo.id).length || !ancora.isConnected) return;
      this.fecharPrevia(true);
      const el = document.body.createDiv("ct-previa");
      const componente = new Component();
      componente.load();
      renderizarAnexos(this, el.createDiv("ct-anexos"), alvo.id, { caminhoNota: alvo.arquivo.path, componente });
      el.addEventListener("mouseenter", () => clearTimeout(this.esperaFechar));
      el.addEventListener("mouseleave", () => this.fecharPrevia());
      this.previa = { el, componente };

      // Abaixo do clipe, ou acima se não couber, sem sair da janela
      const r = ancora.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
      const abaixo = r.bottom + 6;
      el.style.top = abaixo + el.offsetHeight > window.innerHeight - 8
        ? `${Math.max(8, r.top - 6 - el.offsetHeight)}px`
        : `${abaixo}px`;
      // Imagens carregam depois e mudam a altura: reposiciona se passar do fim da janela
      for (const img of el.querySelectorAll("img")) {
        img.addEventListener("load", () => {
          const fundo = el.getBoundingClientRect().bottom;
          if (fundo > window.innerHeight - 8) el.style.top = `${Math.max(8, r.top - 6 - el.offsetHeight)}px`;
        });
      }
    }, 250);
  }

  fecharPrevia(agora = false) {
    clearTimeout(this.esperaPrevia);
    clearTimeout(this.esperaFechar);
    const fechar = () => {
      if (!this.previa) return;
      this.previa.componente.unload();
      this.previa.el.remove();
      this.previa = null;
    };
    if (agora) fechar();
    else this.esperaFechar = setTimeout(fechar, 200);
  }

  onunload() {
    this.fecharPrevia(true);
    this.desligarGrafo();
  }

  // ---------------------------------------------------------------- grafo

  /**
   * Intercepta o envio dos dados ao renderizador de cada grafo global aberto, para incluir os pesos
   * por nível. Com `redesenhar`, refaz também os grafos já ajustados (depois de mudar a opção).
   */
  ajustarGrafos(redesenhar = false) {
    for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
      const { renderer, dataEngine } = leaf.view;
      if (!renderer?.setData) continue;
      const novo = !renderer.ctSetDataOriginal;
      if (novo) {
        const original = renderer.setData;
        renderer.ctSetDataOriginal = original;
        renderer.setData = (dados) => original.call(renderer, this.comPesos(dados));
      }
      if (novo || redesenhar) dataEngine?.render?.();
    }
  }

  desligarGrafo() {
    for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
      const { renderer, dataEngine } = leaf.view;
      if (!renderer?.ctSetDataOriginal) continue;
      renderer.setData = renderer.ctSetDataOriginal;
      delete renderer.ctSetDataOriginal;
      dataEngine?.render?.();
    }
  }

  comPesos(dados) {
    const modo = this.config.tamanhoGrafo;
    // Dados que já trazem pesos (como os do grafo local) ficam como estão
    if (modo === "links" || !dados?.nodes || dados.weights) return dados;
    const raiz = modo === "raiz" ? this.raizDoGrafo() : null;
    if (modo === "raiz" && !raiz) return dados;
    return Object.assign({}, dados, { weights: pesosDoGrafo(dados.nodes, modo, raiz) });
  }

  /** Caminho da nota raiz configurada, aceitando o nome, o caminho ou um [[link]]. */
  raizDoGrafo() {
    const nome = this.config.raizGrafo.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0];
    return nome ? this.app.metadataCache.getFirstLinkpathDest(nome, "")?.path ?? null : null;
  }

  /** O cartão precisa de id para guardar anexos. Se ainda não tem, grava um pelo editor. */
  garantirId(alvo) {
    if (!alvo || alvo.id) return alvo?.id;
    const conhecidos = new Set([...Object.keys(this.dados.cartoes), ...Object.keys(this.dados.anexos)]);
    for (const { cartoes } of this.cache.values()) for (const k of cartoes) if (k.id) conhecidos.add(k.id);
    const id = novoId(conhecidos);
    const linha = alvo.view.state.doc.line(alvo.numeroLinha);
    const espaco = /[ \t]$/.test(linha.text) ? "" : " ";
    alvo.view.dispatch({ changes: { from: linha.to, insert: `${espaco}^${id}` } });
    alvo.id = id;
    return id;
  }

  async adicionarAnexo(alvo, anexo) {
    const id = this.garantirId(alvo);
    if (!id) return;
    const lista = this.dados.anexos[id] || (this.dados.anexos[id] = []);
    lista.push({ ...anexo, criado: Date.now() });
    await this.salvar();
    this.redesenharEditores();
  }

  async removerAnexo(id, anexo) {
    const lista = this.anexosDe(id).filter((a) => a !== anexo);
    if (lista.length) this.dados.anexos[id] = lista;
    else delete this.dados.anexos[id];
    // A imagem foi salva pelo próprio plugin, então vai para a lixeira junto com o anexo
    if (anexo.tipo === "imagem") {
      const arquivo = this.app.vault.getAbstractFileByPath(anexo.caminho);
      if (arquivo instanceof TFile) await this.app.fileManager.trashFile(arquivo);
    }
    await this.salvar();
    this.redesenharEditores();
  }

  async anexarImagens(alvo, arquivos, { avisar = false } = {}) {
    for (const f of arquivos) {
      const caminho = await this.salvarImagem(alvo.arquivo, f.name, await f.arrayBuffer());
      await this.adicionarAnexo(alvo, { tipo: "imagem", caminho });
    }
    if (avisar) {
      const n = arquivos.length;
      new Notice(`📎 ${n === 1 ? "Imagem anexada" : `${n} imagens anexadas`} a "${textoDoContexto(alvo.frente)}"`);
    }
  }

  async salvarImagem(arquivoNota, nomeOriginal, dados) {
    const ext = (/\.([a-z0-9]+)$/i.exec(nomeOriginal || "")?.[1] || "png").toLowerCase();
    const p = (n) => String(n).padStart(2, "0");
    const d = new Date();
    const base = `${arquivoNota.basename} ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    let pasta = this.pastaImagens();
    if (pasta === null) {
      new Notice(`A pasta das imagens "${this.config.pastaImagens}" fica fora do vault. A imagem foi para a pasta de anexos do Obsidian. Ajuste nas configurações do plugin.`, 10000);
      pasta = "";
    }
    let caminho;
    if (pasta) {
      await this.criarPasta(pasta);
      caminho = `${pasta}/${base}.${ext}`;
      for (let i = 1; this.app.vault.getAbstractFileByPath(caminho); i++) caminho = `${pasta}/${base} ${i}.${ext}`;
    } else {
      // Sem pasta configurada, segue a pasta de anexos das configurações do Obsidian
      caminho = this.app.fileManager.getAvailablePathForAttachment
        ? await this.app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, arquivoNota.path)
        : `${base}.${ext}`;
    }
    const arquivo = await this.app.vault.createBinary(caminho, dados);
    return arquivo.path;
  }

  /**
   * Pasta das imagens, relativa ao vault. Aceita também o caminho completo do sistema, desde que
   * aponte para dentro do vault. Fora dele, devolve null.
   */
  pastaImagens() {
    let pasta = this.config.pastaImagens.trim().replace(/\\/g, "/");
    const raiz = this.app.vault.adapter.getBasePath?.()?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (raiz && (pasta === raiz || pasta.startsWith(raiz + "/"))) {
      pasta = pasta.slice(raiz.length);
    } else if (raiz && /^\/|^[A-Za-z]:\//.test(pasta) && pasta.split("/")[1] === raiz.split("/")[1]) {
      // Caminho do sistema, como /home/..., que não fica dentro do vault
      return null;
    }
    return normalizePath(pasta || "/").replace(/^\/+|\/+$/g, "");
  }

  async criarPasta(caminho) {
    let atual = "";
    for (const parte of caminho.split("/")) {
      atual = atual ? `${atual}/${parte}` : parte;
      if (!this.app.vault.getAbstractFileByPath(atual)) await this.app.vault.createFolder(atual);
    }
  }

  /** Imagem anexada (ou a pasta dela) movida ou renomeada: o anexo segue o novo caminho. */
  async acompanharRenomeacao(arquivo, antigo) {
    let mudou = false;
    for (const lista of Object.values(this.dados.anexos)) {
      for (const a of lista) {
        if (a.tipo !== "imagem") continue;
        if (a.caminho === antigo) a.caminho = arquivo.path;
        else if (a.caminho.startsWith(antigo + "/")) a.caminho = arquivo.path + a.caminho.slice(antigo.length);
        else continue;
        mudou = true;
      }
    }
    if (mudou) await this.salvar();
  }

  tamanhoTab() {
    return this.app.vault.getConfig?.("tabSize") ?? 4;
  }

  arquivosNoEscopo(escopo) {
    const ignoradas = this.config.pastasIgnoradas.split(",").map((p) => p.trim().replace(/\/$/, "")).filter(Boolean);
    return this.app.vault.getMarkdownFiles().filter((f) => {
      if (ignoradas.some((p) => f.path === p || f.path.startsWith(p + "/"))) return false;
      if (escopo instanceof TFile) return f.path === escopo.path;
      if (escopo instanceof TFolder) return escopo.isRoot() || f.path.startsWith(escopo.path + "/");
      return true;
    });
  }

  /** Cartões e cobertura de uma nota, guardados em cache até a nota mudar. */
  async analiseDe(arquivo) {
    const guardado = this.cache.get(arquivo.path);
    if (guardado && guardado.mtime === arquivo.stat.mtime) return guardado;
    const texto = await this.app.vault.cachedRead(arquivo);
    const analise = texto.includes("==")
      ? analisarNota(texto, this.tamanhoTab())
      : { cartoes: [], cobertos: 0, semCartao: 0 };
    for (const c of analise.cartoes) c.arquivo = arquivo;
    const resultado = { ...analise, arquivo, mtime: arquivo.stat.mtime };
    this.cache.set(arquivo.path, resultado);
    return resultado;
  }

  async cartoesDe(arquivo) {
    return (await this.analiseDe(arquivo)).cartoes;
  }

  async todosOsCartoes(arquivos) {
    const porArquivo = await Promise.all(arquivos.map((a) => this.cartoesDe(a)));
    return porArquivo.flat();
  }

  /** Grava um block id nos cartões que ainda não têm (ou que têm um id repetido por copiar e colar). */
  async garantirIds() {
    const arquivos = this.arquivosNoEscopo(null);
    const cartoes = await this.todosOsCartoes(arquivos);
    const vistos = new Set(cartoes.map((c) => c.id).filter(Boolean));
    const usados = new Set();
    const pendentes = new Map();
    for (const c of cartoes) {
      if (c.id && !usados.has(c.id)) {
        usados.add(c.id);
        continue;
      }
      c.novoId = novoId(vistos);
      vistos.add(c.novoId);
      if (!pendentes.has(c.arquivo)) pendentes.set(c.arquivo, []);
      pendentes.get(c.arquivo).push(c);
    }

    for (const [arquivo, lista] of pendentes) {
      await this.app.vault.process(arquivo, (texto) => {
        const linhas = texto.split("\n");
        for (const c of lista) {
          const atual = linhas[c.linha];
          if (atual === undefined || atual.replace(/\r$/, "") !== c.textoLinha) continue;
          const cr = atual.endsWith("\r") ? "\r" : "";
          const base = c.textoLinha.replace(RE_ID, "").replace(/[ \t]+$/, "");
          linhas[c.linha] = `${base} ^${c.novoId}${cr}`;
        }
        return linhas.join("\n");
      });
      this.cache.delete(arquivo.path);
    }
  }

  async revisar(escopo) {
    try {
      await this.garantirIds();
    } catch (erro) {
      console.error(erro);
      new Notice("Não foi possível gravar os ids dos cartões: " + erro.message);
    }
    const cartoes = (await this.todosOsCartoes(this.arquivosNoEscopo(escopo))).filter((c) => c.id);
    const hoje = hojeISO();
    const vencidos = [];
    const novos = [];
    for (const c of [...cartoes, ...this.cartoesDeItens(cartoes)]) {
      const estado = this.dados.cartoes[c.id];
      if (!estado) novos.push(c);
      else if (estado.vencimento <= hoje) vencidos.push(c);
    }
    vencidos.sort((a, b) => this.dados.cartoes[a.id].vencimento.localeCompare(this.dados.cartoes[b.id].vencimento));

    // O limite diário de novos vale só para a revisão geral. Revisando uma nota ou pasta, entram todos.
    const limite = escopo ? novos.length : Math.max(0, this.config.novosPorDia - this.novosHoje());
    const fila = [...vencidos, ...novos.slice(0, limite)];
    const titulo = escopo ? escopo.name.replace(/\.md$/, "") || "Vault" : "Todos os cartões";
    new ModalRevisao(this, fila, { titulo, livre: false, todos: cartoes }).open();
  }

  novosHoje() {
    return this.dados.novos.dia === hojeISO() ? this.dados.novos.n : 0;
  }

  /**
   * Itens de cartões de lista que viraram cartões próprios ao serem marcados como "não lembrei".
   * Não ficam na nota: cada um existe enquanto tiver agendamento no data.json, com o id
   * `<id do cartão>~<hash do texto do item>`.
   */
  cartoesDeItens(cartoes) {
    const itens = [];
    const vistos = new Set();
    for (const c of cartoes) {
      if (!c.id || !c.itens.length) continue;
      c.itens.forEach((texto, i) => {
        const id = idDoItem(c.id, texto);
        if (!this.dados.cartoes[id] || vistos.has(id)) return;
        vistos.add(id);
        itens.push({ ...c, id, itemAlvo: i, pai: c.id });
      });
    }
    return itens;
  }

  /** Itens marcados como "não lembrei": viram cartões para hoje, ou voltam ao começo se já eram. */
  async esquecerItens(cartao, indices) {
    const hoje = hojeISO();
    const itens = [];
    for (const i of indices) {
      const id = idDoItem(cartao.id, cartao.itens[i]);
      const estado = this.dados.cartoes[id];
      this.dados.cartoes[id] = estado
        ? agendar(estado, 1, hoje, this.config.intervaloMaximo)
        : { intervalo: 0, facilidade: 2.5, repeticoes: 0, lapsos: 0, vencimento: hoje, ultima: hoje };
      itens.push({ ...cartao, id, itemAlvo: i, pai: cartao.id });
    }
    await this.salvar();
    return itens;
  }

  async registrarResposta(cartao, nota, tempo) {
    const hoje = hojeISO();
    const estado = this.dados.cartoes[cartao.id];
    if (!estado) this.dados.novos = { dia: hoje, n: this.novosHoje() + 1 };
    const novo = agendar(estado, nota, hoje, this.config.intervaloMaximo);
    this.dados.cartoes[cartao.id] = novo;
    // Item de lista que ficou maduro já foi aprendido: volta a ser cobrado só no cartão da lista
    if (cartao.pai && novo.intervalo >= MADURO) delete this.dados.cartoes[cartao.id];
    // O tempo de uma resposta conta no máximo 60 segundos, para pausas não distorcerem a média
    const linha = [];
    linha[H.instante] = Date.now();
    linha[H.id] = cartao.id;
    linha[H.nota] = nota;
    linha[H.antes] = estado ? estado.intervalo : -1;
    linha[H.depois] = novo.intervalo;
    linha[H.tempo] = Math.min(Math.round(tempo || 0), 60000);
    this.dados.historico.push(linha);
    await this.salvar();
  }

  async coletarEstatisticas(periodo) {
    const analises = await Promise.all(this.arquivosNoEscopo(null).map((a) => this.analiseDe(a)));
    const notas = analises.filter((n) => n.cartoes.length);
    const cartoes = notas.flatMap((n) => n.cartoes);
    const e = calcularEstatisticas({
      cartoes: [...cartoes, ...this.cartoesDeItens(cartoes)],
      estados: this.dados.cartoes,
      historico: this.dados.historico,
      notas,
      periodo,
      diasExtras: Object.keys(this.dados.jogo.dias),
    });
    e.novosDisponiveis = Math.min(e.contagem.novo, Math.max(0, this.config.novosPorDia - this.novosHoje()));
    e.xpHoje = this.dados.jogo.dias[hojeISO()] || 0;
    e.novosHoje = this.novosHoje();
    return e;
  }

  /** Revisão sem mexer no agendamento, como a de "Estudar de novo" nos erros recentes. */
  praticar(cartoes, titulo) {
    new ModalRevisao(this, embaralhar([...cartoes]), { titulo, livre: true, todos: cartoes }).open();
  }

  async abrirEstatisticas() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VISAO_ESTATISTICAS)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VISAO_ESTATISTICAS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async abrirCartao(c) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(c.arquivo, { eState: { line: c.linha } });
    const editor = leaf.view?.editor;
    if (editor) {
      editor.setCursor({ line: c.linha, ch: editor.getLine(c.linha).length });
      editor.scrollIntoView({ from: { line: c.linha, ch: 0 }, to: { line: c.linha, ch: 0 } }, true);
    }
  }

  async atualizarStatusNota() {
    const arquivo = this.app.workspace.getActiveFile();
    const analise = arquivo && arquivo.extension === "md" && this.arquivosNoEscopo(arquivo).length
      ? await this.analiseDe(arquivo)
      : null;
    if (!analise || !analise.cartoes.length) {
      this.statusNota.setText("");
      this.statusNota.hide();
      return;
    }
    const hoje = hojeISO();
    const vencidos = analise.cartoes.filter((c) => c.id && this.dados.cartoes[c.id]?.vencimento <= hoje).length;
    const cobertura = situacaoCobertura(analise);
    const partes = [plural(analise.cartoes.length, "card", "cards")];
    if (vencidos) partes.push(`${vencidos} para revisar`);
    partes.push(cobertura.texto.toLowerCase());
    this.statusNota.show();
    this.statusNota.setText(`📄 ${partes.join(" · ")}`);
    this.statusNota.setAttribute(
      "aria-label",
      analise.semCartao
        ? `${plural(analise.semCartao, "trecho", "trechos")} desta nota ainda sem card (${pct(cobertura.proporcao)} coberto). Clique para ver as estatísticas.`
        : "Todo o conteúdo desta nota está em cards. Clique para ver as estatísticas."
    );
  }

  async atualizarStatus() {
    const cartoes = await this.todosOsCartoes(this.arquivosNoEscopo(null));
    const hoje = hojeISO();
    let vencidos = 0;
    let novos = 0;
    for (const c of [...cartoes, ...this.cartoesDeItens(cartoes)]) {
      const estado = c.id && this.dados.cartoes[c.id];
      if (!estado) novos += 1;
      else if (estado.vencimento <= hoje) vencidos += 1;
    }
    novos = Math.min(novos, Math.max(0, this.config.novosPorDia - this.novosHoje()));
    this.status.setText(cartoes.length ? `🗂 ${vencidos} para revisar · ${novos} novos` : "");
    this.status.setAttribute("aria-label", "Clique para revisar os flashcards");
    await this.atualizarStatusNota();
    for (const leaf of this.app.workspace.getLeavesOfType(VISAO_ESTATISTICAS)) leaf.view.renderizar?.();
  }
};

function debounce(fn, espera) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), espera);
  };
}

// ------------------------------------------------------------------ configurações

class AbaConfiguracoes extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    const numero = (nome, desc, chave, min) =>
      new Setting(containerEl).setName(nome).setDesc(desc).addText((t) =>
        t.setValue(String(p.config[chave])).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= min) {
            p.config[chave] = n;
            await p.salvar();
            p.atualizarStatus();
          }
        })
      );

    numero("Cartões novos por dia", "Limite de cartões novos na revisão geral. Revisando uma nota ou pasta, entram todos.", "novosPorDia", 0);
    numero("Intervalo máximo (dias)", "Maior intervalo entre duas revisões.", "intervaloMaximo", 1);

    new Setting(containerEl)
      .setName("Pastas ignoradas")
      .setDesc("Separadas por vírgula. Cartões dentro delas não entram na revisão.")
      .addText((t) =>
        t.setPlaceholder("Templates, Arquivo").setValue(p.config.pastasIgnoradas).onChange(async (v) => {
          p.config.pastasIgnoradas = v;
          await p.salvar();
          p.atualizarStatus();
        })
      );

    new Setting(containerEl)
      .setName("Enter depois de == começa a lista")
      .setDesc("Em um bullet terminado em ==, o Enter desce um nível e já cria o bullet do primeiro item da resposta.")
      .addToggle((t) =>
        t.setValue(p.config.enterCriaCheckbox).onChange(async (v) => {
          p.config.enterCriaCheckbox = v;
          await p.salvar();
        })
      );

    new Setting(containerEl)
      .setName("Mostrar seta no lugar de ==")
      .setDesc("No Live Preview e no modo leitura, o == vira uma seta e o id do cartão fica escondido.")
      .addToggle((t) =>
        t.setValue(p.config.mostrarSeta).onChange(async (v) => {
          p.config.mostrarSeta = v;
          await p.salvar();
          this.app.workspace.updateOptions();
        })
      );

    new Setting(containerEl)
      .setName("Colar imagem num cartão vira anexo")
      .setDesc("Com o cursor num cartão, colar ou arrastar uma imagem anexa ao cartão em vez de inserir no texto.")
      .addToggle((t) =>
        t.setValue(p.config.colarNoCartao).onChange(async (v) => {
          p.config.colarNoCartao = v;
          await p.salvar();
        })
      );

    new Setting(containerEl)
      .setName("Pasta das imagens dos cartões")
      .setDesc("Caminho dentro do vault, como Imagens ou Anexos/Flashcards. A pasta é criada se não existir. Vazio usa a pasta de anexos das configurações do Obsidian.")
      .addText((t) =>
        t.setPlaceholder("Anexos/Flashcards").setValue(p.config.pastaImagens).onChange(async (v) => {
          p.config.pastaImagens = v;
          await p.salvar();
        })
      );

    new Setting(containerEl).setName("Aparência das notas").setHeading();
    new Setting(containerEl)
      .setName("Destacar tópicos")
      .setDesc("Bullets que agrupam outros bullets (e não são cartões) ganham um fundo, mais forte no primeiro nível.")
      .addToggle((t) =>
        t.setValue(p.config.destacarTopicos).onChange(async (v) => {
          p.config.destacarTopicos = v;
          await p.salvar();
          this.app.workspace.updateOptions();
        })
      );
    new Setting(containerEl)
      .setName("Barra de formatação na seleção")
      .setDesc("Ao selecionar um trecho de uma linha, mostra negrito e marca-texto em cores.")
      .addToggle((t) =>
        t.setValue(p.config.barraSelecao).onChange(async (v) => {
          p.config.barraSelecao = v;
          await p.salvar();
        })
      );

    new Setting(containerEl).setName("Grafo").setHeading();
    const redesenhar = debounce(() => p.ajustarGrafos(true), 400);
    new Setting(containerEl)
      .setName("Tamanho dos nós no grafo")
      .setDesc("Vale para o grafo global. O controle de tamanho do nó nas opções do grafo continua ajustando a escala geral.")
      .addDropdown((d) =>
        d
          .addOptions({
            links: "Número de links (padrão do Obsidian)",
            pasta: "Nível da pasta (raiz do vault maior)",
            raiz: "Distância até a nota raiz",
          })
          .setValue(p.config.tamanhoGrafo)
          .onChange(async (v) => {
            p.config.tamanhoGrafo = v;
            await p.salvar();
            p.ajustarGrafos(true);
          })
      );
    new Setting(containerEl)
      .setName("Nota raiz do grafo")
      .setDesc("Usada com \"Distância até a nota raiz\": ela fica com o maior nó, e cada link de distância diminui o tamanho. Notas sem caminho até ela ficam com o menor tamanho.")
      .addText((t) =>
        t.setPlaceholder("HOME").setValue(p.config.raizGrafo).onChange(async (v) => {
          p.config.raizGrafo = v;
          await p.salvar();
          redesenhar();
        })
      );

    new Setting(containerEl).setName("Lições").setHeading();
    numero("Meta diária de XP", "Quanto XP de lições conta como dia cumprido. Cada exercício certo de primeira vale 2 XP.", "metaDiaria", 1);

    new Setting(containerEl)
      .setName("Sons nas lições")
      .setDesc("Toca um som curto ao acertar e ao errar.")
      .addToggle((t) =>
        t.setValue(p.config.sonsLicao).onChange(async (v) => {
          p.config.sonsLicao = v;
          await p.salvar();
        })
      );
  }
}

// Exposto só para os testes rodarem fora do Obsidian
module.exports._interno = {
  extrairCartoes, analisarNota, situacaoCobertura, calcularEstatisticas, separarCartao, agendar,
  analisarLinhaEditor, somarDias, formatarIntervalo, H,
  lerLicao, formatarLicao, blocosDeLicao, montarPrompt, conferirDigitado, xpDaLicao, sequenciaDeDias,
  pesosDoGrafo, ILUSTRACOES, svgMedidor, topicoNaLinha, aplicarMarca, alternarNegrito, CORES_MARCA,
};
