# Diagnóstico de Paginação

Se o robô parece estar perdendo grupos que aparecem na **página 2 ou superior** da listagem do portal, precisamos confirmar se o backend pagina o retorno ou se o portal só fatia o resultado no front-end.

## Como capturar o HAR do `listGruposReserva`

1. Abrir o portal no Chrome: <https://parceiros.consorciocanopus.com.br>
2. Fazer login normal (mesma conta usada pelo robô).
3. Pressionar `F12` para abrir o DevTools → aba **Network**.
4. Filtrar por **Fetch/XHR**.
5. Clicar no botão **Nova Reserva** dentro do portal — pode fechar o modal sem reservar nada.
6. Localizar a requisição cujo nome começa com:

   ```
   listGruposReserva/...
   ```

7. Clicar com o botão direito na requisição → **Copy** → **Copy as cURL**.
8. **OU**: clicar na requisição → aba **Preview** → expandir `data` → tirar print da estrutura.
9. **OU**: clicar na requisição → aba **Response** → `Ctrl+A` → `Ctrl+C` → colar em um `.txt`.
10. Enviar o arquivo ou screenshot para o suporte.

## O que vamos verificar no HAR

- **Request body**: tem campo `Page`, `PageSize`, `Offset` ou similar?
- **Response data**: quantos grupos retornam em `data[0]`?
- **Response top-level**: existem campos `totalPages`, `hasNext`, `pageSize`, `currentPage`?

## Cenários possíveis

- **Mais de 300 grupos em uma única response** → backend retorna tudo de uma vez. Paginação é **client-side** no portal UI. O robô já vê todos os grupos, e o bug está em outro lugar (parser, filtro, comparação de `CD_Grupo`).
- **Cerca de 100 grupos e existe campo `Page` no body** → backend pagina. O robô só vê a página 1. Precisamos adicionar loop de paginação no `buscarGrupos`.

## Diagnóstico via telemetria (sem precisar do HAR ainda)

Enquanto não recebemos o HAR, a partir de **v1.2.0** o robô emite dois eventos de diagnóstico:

- `buscarGrupos.resultado` — quantos grupos vieram do backend, primeiros 5 `CD_Grupo`, e shape da response.
- `filter.detectados` — quantos passaram pelo filtro de grupos configurados, com os `CD_Grupo` brutos.

Para coletar:

1. Em **Configurações → Telemetria**, ligar o toggle.
2. Iniciar o robô e deixar rodar uns 5 ciclos.
3. Em **Logs**, clicar **Exportar telemetria**.
4. Enviar o arquivo `.json` para o suporte.
