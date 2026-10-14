# Cartinha

Plugin do Obsidian que transforma bullets em flashcards. Você escreve as notas normalmente e os
cartões saem delas, sem arquivo separado e sem sair do fluxo.

## Sintaxe

**Cartão simples:** pergunta e resposta na mesma linha, separadas por `==`.

```markdown
- O que o TCP garante? == Entrega confiável e ordenada
```

**Cartão de lista:** termine o bullet com `==`. Aparece o popup *Começar lista de respostas* e o
Enter desce um nível, já com o bullet do primeiro item. Cada Enter seguinte cria outro item,
e um Enter num item vazio volta um nível, como em qualquer lista do Obsidian. Esse popup ocupa o
lugar do seletor de cor do destaque, que o Obsidian abriria nesse ponto. Fora de um cartão, o
seletor de cor continua aparecendo normalmente.

```markdown
- Etapas do handshake do TCP ==
	- SYN
	- SYN-ACK
	- ACK
```

Detalhes:

- O `==` precisa de espaço antes, e de espaço ou fim de linha depois. Assim o destaque do
  Obsidian (`==texto==`) continua funcionando e não vira cartão.
- Só bullets (`-`, `*`, `+` ou numerados) viram cartão. Texto solto, código e frontmatter são
  ignorados.
- No cartão de lista, só os bullets do primeiro nível abaixo da pergunta são itens da resposta.
  O que estiver aninhado dentro de um item fica só na nota e não aparece na revisão. Se um desses
  sub-bullets tiver `==`, ele continua sendo um cartão próprio.
- Os títulos e os bullets pais aparecem como contexto na revisão: acima da pergunta vem o caminho em letra pequena e, logo abaixo, o pai direto em destaque. Então dá para
  escrever `- Lead time` e aninhar dentro uma pergunta curta como `- O que mede? == …`: na revisão
  ela aparece como *Lead time* › *O que mede?*. Se o caminho for longo, ele é cortado pelo começo,
  e o pai continua visível.
- No Live Preview, o `==` vira uma seta `→`. Ao colocar o cursor na linha, o `==` volta a aparecer.

## Revisão

- **Ícone de camadas na barra lateral**, **contador na barra de status** ou comando
  *Revisar flashcards*: revisa os cartões vencidos de todo o vault e os novos do dia.
- Comando *Revisar flashcards desta nota*, ou clique com o botão direito numa nota ou pasta e
  escolha *Revisar flashcards*: revisa só aquele escopo, com todos os cartões novos.
- Se não houver nada vencido, dá para praticar todos os cartões do escopo sem alterar o
  agendamento.

No cartão de lista, os itens começam escondidos. Tente lembrar cada um antes de revelar. Quando
todos estiverem revelados, os botões de avaliação aparecem.

### Itens que você não lembrou

Depois de revelar um item do cartão de lista, clique nele (ou aperte X logo depois de revelar)
para marcar que não lembrou. Ele fica vermelho, com o texto *não lembrei*. Clicar de novo
desmarca.

Ao avaliar o cartão, cada item marcado vira um cartão próprio, que entra no fim da mesma sessão.
Nesse cartão, a pergunta aparece com os outros itens à vista como pista, e só o item esquecido fica
escondido. Ele tem agendamento próprio e sai sozinho quando fica maduro (21 dias): a partir daí, o
item volta a ser cobrado só dentro do cartão da lista. Se você marcar de novo um item que já era
cartão, ele volta para o começo.

- Nada é escrito na nota: esses cartões ficam no `data.json`, ligados ao cartão da lista e ao
  texto do item. Se você mudar o texto do item, o cartão dele deixa de aparecer.
- Na prática livre não dá para marcar itens, porque ela não mexe no agendamento.

| Tecla | Ação |
| --- | --- |
| Espaço | mostra a resposta ou revela o próximo item |
| 1 2 3 4 | Errei, Difícil, Bom, Fácil |
| X | marca (ou desmarca) como não lembrado o último item revelado do cartão de lista |
| Esc | encerra a sessão |

### Agendamento

É a repetição espaçada clássica, baseada num fator de facilidade por cartão:

| Botão | Efeito no intervalo | Efeito na facilidade |
| --- | --- | --- |
| Errei | volta a zero, o cartão reaparece na mesma sessão | −20% (mínimo 130%) |
| Difícil | × 1,2 | −15% |
| Bom | × facilidade | — |
| Fácil | × facilidade × 1,3 | +15% |

A facilidade começa em 250% e um cartão vira *maduro* com intervalo de 21 dias. Não há etapas
de aprendizado em minutos: um cartão errado volta alguns cartões depois na mesma sessão e, ao
acertar, vai para o dia seguinte. Os intervalos também não têm variação aleatória: o mesmo
histórico sempre leva à mesma data.

## Anexos

Imagens, links e comentários ligados a um cartão sem aparecer no texto da nota.

- **Passar o mouse no clipe 📎** no fim da linha do cartão mostra uma prévia com os anexos. Dá
  para levar o mouse até a prévia para clicar num link ou ampliar uma imagem.
- **Clicar no clipe** abre um modal para gerenciar os anexos: *Imagem*, *Link* (endereço
  `https://…` ou `[[Nota]]`), *Comentário* (aceita Markdown, Ctrl+Enter salva), colar (Ctrl+V)
  ou arrastar imagens. O ✕ aparece ao passar o mouse num anexo e o remove.
- O mesmo modal abre pelo comando *Anexos do cartão* ou pelo clique direito no cartão.
- **Colar direto na nota:** tire o print, deixe o cursor na linha do cartão (ou num item dele) e
  aperte Ctrl+V. A imagem vira anexo do cartão em vez de entrar no texto. Arrastar uma imagem
  para cima da linha do cartão faz o mesmo. Fora de cartões, colar funciona como sempre. Dá para
  desligar em *Colar imagem num cartão vira anexo*, nas configurações.
- **No editor:** o clipe aparece com a quantidade de anexos nos cartões que têm. Nos outros, só na
  linha do cursor ou com o mouse em cima.
- **Na revisão:** o botão de clipe no topo abre os anexos numa coluna ao lado do cartão. Depois de
  aberta, a coluna aparece sozinha nos cartões seguintes, mas só depois de revelar a resposta,
  para não entregá-la. Para ver um anexo antes de responder, clique no clipe.
- As imagens viram arquivos na *Pasta das imagens dos cartões*, nas configurações do plugin (por
  exemplo `Anexos/Flashcards`). Se ela estiver vazia, vão para a pasta de anexos configurada no
  Obsidian. Remover um anexo de imagem manda o arquivo para a lixeira.
- Dá para mover ou renomear as imagens (ou a pasta delas) pelo Obsidian: os anexos acompanham o
  novo caminho. Mover pelo gerenciador de arquivos do sistema, com o Obsidian fechado, quebra o
  link.
- Os anexos ficam no `data.json`, ligados ao id do cartão. Se o cartão ainda não tem id, ele ganha
  um no primeiro anexo.

## Estatísticas

Ícone de gráfico na barra lateral, comando *Abrir estatísticas* ou o botão no fim de cada sessão.

A tela é um painel em grade, ilustrado pela Cartinha, o mascote do plugin: um cartão de fichário
que muda conforme a situação (pula com cartões novos, dorme quando não há revisões, comemora as
revisões do dia, reage à taxa de acertos). Ela também aparece no fim das revisões.

- **Novos e Revisões:** quantos cartões novos estão liberados hoje (ou *Feito!*, se o limite do
  dia já foi), quantos esperam revisão, e o botão para começar.
- **Amanhã e os próximos dias:** quantos cartões vencem em cada um dos próximos dias e o total
  que acumula se você não revisar.
- **Sequência:** dias seguidos estudando (revisão ou lição), os últimos 7 dias marcados, a melhor
  sequência e o XP de lições de hoje.
- **Revisões feitas** hoje, com o tempo gasto e a comparação com ontem.
- **Erros recentes:** os cartões em que você apertou *Errei* nas últimas 24 horas, como etiquetas
  que abrem o cartão, e *Estudar de novo*, que revisa só eles sem mexer no agendamento.
- **Acertos:** a parte das respostas que não foram *Errei* nos últimos 7 dias, num medidor em
  segmentos com a faixa ideal (80% a 95%) marcada em verde, a diferença para a semana anterior e
  quantas vezes cada botão foi usado.
- **Cartões** por maturidade (novos, aprendendo, jovens, maduros), **Próximos 30 dias** e um mapa
  de **Atividade** das últimas 26 semanas.
- **Histórico (7, 30, 90 dias ou tudo):** revisões por dia e, no rodapé, o total de revisões, os
  acertos, o tempo médio por cartão e quantos dias você estudou.
- **Notas:** primeiro as que pedem ação. Cada nota mostra a maturidade dos cartões e um status:
  quantos estão para revisar, se faltam cards (veja a cobertura abaixo) ou *Em dia*. O botão ▶
  revisa só aquela nota.
- **Cartões mais difíceis:** os que você mais errou depois de já ter acertado. Clique para abrir.

Os gráficos mostram o valor ao passar o mouse ou com o foco do teclado.

### Cobertura: falta fazer card nesta nota?

O plugin conta os trechos de conteúdo de cada nota (bullets e parágrafos com texto) e quantos já
estão num cartão, seja como pergunta, seja como item de resposta. Bullets que só agrupam cartões
(como `- Camada de transporte` com cartões dentro) não contam nem a favor nem contra.

| Situação | Quando |
| --- | --- |
| Tudo coberto / Boa cobertura | nenhum trecho fora de cartão, ou 60% ou mais cobertos |
| Pode ter mais cards | entre 30% e 60% cobertos |
| Faltam cards | menos de 30% cobertos |

Os limites são uma heurística para apontar notas com muito conteúdo ainda fora dos cartões, não
uma meta de transformar todo bullet em cartão. A nota aberta mostra esse resumo na barra de
status (por exemplo `📄 5 cards · 2 para revisar · faltam cards`). Passe o mouse para ver
quantos trechos estão sem card.

## Lições geradas por IA

Além dos cartões, uma nota pode ter lições curtas e gamificadas, com exercícios variados, geradas
por qualquer assistente de IA a partir das suas anotações.

1. Clique com o botão direito na nota (no explorador de arquivos ou dentro do texto) e escolha
   *Copiar para a IA*. Isso copia o pedido com o formato exigido e as suas anotações: a nota
   inteira ou, se houver texto selecionado no editor, só a seleção (*Copiar seleção para a IA*).
2. Cole na IA e copie a resposta.
3. Clique com o botão direito na nota e escolha *Colar lição da IA*. O plugin confere o formato e,
   se estiver tudo certo, acrescenta a lição no fim da nota. Se não estiver, mostra o que está
   errado e não mexe na nota.

O prompt pede para a IA ajustar o tamanho da lição ao das anotações: 10 exercícios para notas
curtas (até 15 bullets ou parágrafos), 20 para médias (até 40) e 40 para longas, que é o máximo.
A contagem é feita pela IA, então o número pode variar um pouco.

Os dois também estão na paleta de comandos (Ctrl+P). Colar a resposta com Ctrl+V direto no texto
também funciona, e aí a lição fica onde estiver o cursor.

A lição vira um bloco ` ```licao ` na nota, que aparece como um cartão com o botão *Começar*. Se o
JSON estiver fora do formato, o bloco mostra a lista de problemas em vez de abrir a lição. Também
dá para abrir pelo comando *Fazer lição desta nota*, que escolhe a lição ainda não feita ou a de
pior resultado.

| Tipo | Exercício |
| --- | --- |
| `escolha` | múltipla escolha, uma opção certa |
| `vf` | verdadeiro ou falso |
| `lacuna` | completar a frase com uma das peças |
| `pares` | associar os itens de duas colunas |
| `digitar` | resposta curta digitada; ignora maiúsculas e acentos e aceita um erro de digitação |

Na lição:

- Cada exercício tem *Verificar* e depois *Continuar* (ou Enter), com uma faixa verde ou vermelha,
  a resposta certa e a explicação.
- O que você errou volta no fim da lição, até acertar.
- As teclas 1 a 9 escolhem opções e peças, e o Backspace esvazia a lacuna.
- Três acertos seguidos acendem o combo 🔥.
- No fim aparecem as estrelas (3 sem erros, 2 com 80% ou mais de acertos de primeira, 1 nos outros
  casos), o XP, a meta diária e a ofensiva.

XP: 2 por exercício certo de primeira, mais 5 se a lição saiu sem erros. A ofensiva conta os dias
seguidos com revisão de cartões ou com lição, e é o mesmo número de *Sequência* nas estatísticas.
As lições não mexem no agendamento dos cartões.

O progresso de cada lição (melhor resultado e quantas vezes foi feita) fica em `data.json`, ligado
ao conteúdo dela. Se você gerar a lição de novo ou editar o JSON, ela conta como nova.

## Aparência das notas

- **Tópicos em destaque:** bullets que agrupam outros bullets e não são cartões (como
  `- Redução de Dimensionalidade` com cartões dentro) ganham um fundo de etiqueta, no Live
  Preview e no modo leitura. O primeiro nível tem a cor de destaque e uma barra à esquerda; os de
  dentro, um fundo cinza. É só aparência: a nota não muda. Desliga em *Destacar tópicos*.
- **Barra de formatação:** ao selecionar um trecho dentro de uma linha, aparece uma barrinha com
  negrito, marca-texto em cinco cores e um botão para tirar o marca-texto. Clicar de novo na mesma
  cor tira a marca; clicar noutra cor troca. O amarelo é o `==destaque==` do Obsidian; as outras
  cores são gravadas como `<mark class="ct-mt-azul">…</mark>`, que o Obsidian mostra colorido
  (sem o plugin, aparece como marca-texto comum). Desliga em *Barra de formatação na seleção*.

## Tamanho dos nós no grafo

Por padrão, o grafo global do Obsidian deixa maiores as notas com mais links. Em *Tamanho dos nós
no grafo*, nas configurações, dá para trocar isso pelo nível da nota na hierarquia:

- **Nível da pasta:** notas na raiz do vault ficam com o maior nó, e cada pasta a mais diminui o
  tamanho. As notas da pasta mais funda ficam com o menor.
- **Distância até a nota raiz:** a nota escolhida em *Nota raiz do grafo* (por exemplo `HOME`) fica
  com o maior nó. As notas ligadas a ela, num sentido ou no outro, vêm logo abaixo, e cada link
  de distância diminui o tamanho. Notas sem caminho até a raiz ficam com o menor.

Tags e links para notas que não existem ficam sempre com o menor tamanho. O grafo local não muda.
O controle *Tamanho do nó*, nas opções do grafo, continua ajustando a escala geral.

O Obsidian não tem uma API para isso, então o plugin mexe numa parte interna do grafo. Se uma
atualização do Obsidian mudar essa parte, o grafo volta a usar o número de links.

## Onde ficam os dados

- Na primeira revisão, cada cartão recebe um block id no fim da linha da pergunta, como
  `^ct-k3x9qa`. No Live Preview ele fica escondido e no modo leitura o Obsidian já não o mostra.
- O histórico de cada cartão (intervalo, facilidade, próxima revisão) fica em `data.json`, na
  pasta do plugin, indexado por esse id. Por isso dá para editar o texto, mover o bullet ou
  renomear a nota sem perder o progresso.
- Cada resposta também entra num histórico em `data.json` (instante, cartão, botão, intervalos e
  tempo de resposta, limitado a 60 segundos). As estatísticas saem dele, então o
  histórico começa a partir desta versão do plugin.
- Se você copiar e colar um cartão com id, a cópia ganha um id novo na próxima revisão.
- As primeiras versões usavam ids com outro prefixo (`^rn-…`). Na primeira vez que a Cartinha
  carrega, ela troca esses ids pelo formato novo nas notas e no `data.json`, sem perder o progresso.

## Instalação

O plugin é JavaScript puro, sem etapa de build. Crie um link da pasta dentro do vault:

```bash
ln -s "$PWD" "/caminho/do/vault/.obsidian/plugins/cartinha"
```

Depois, em Configurações → Plugins da comunidade, ative **Cartinha**. Com o link, qualquer mudança
feita aqui vale no Obsidian depois de recarregar o plugin.

## Configurações

- **Cartões novos por dia:** limite de novos na revisão geral (padrão 20).
- **Intervalo máximo:** maior intervalo entre revisões, em dias.
- **Pastas ignoradas:** pastas cujos cartões não entram na revisão, como `Templates`.
- **Enter depois de == começa a lista:** liga ou desliga o atalho do cartão de lista.
- **Mostrar seta no lugar de ==:** liga ou desliga a seta e o id escondido.
- **Pasta das imagens dos cartões:** onde as imagens anexadas são salvas.
- **Destacar tópicos** e **Barra de formatação na seleção:** ver *Aparência das notas*.
- **Tamanho dos nós no grafo** e **Nota raiz do grafo:** ver acima.
- **Meta diária de XP:** quanto XP de lições cumpre o dia (padrão 20).
- **Sons nas lições:** som curto ao acertar e ao errar.
