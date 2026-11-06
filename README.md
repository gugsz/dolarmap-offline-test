# DolarMap Offline — versão de teste

Cópia separada para testar no iPhone. As pastas `DolarMap` e `DolarMap-publicar` não foram modificadas.

## Funcionalidades

- Abrir pelo ícone da Tela de Início depois de preparar o aplicativo com internet.
- Consultar extrato, saldo e gráficos da última cópia baixada.
- Registrar gastos, compras de dólar e entradas. O lançamento é gravado no IndexedDB antes de aparecer como salvo.
- Editar ou cancelar lançamentos locais que ainda não tiveram uma tentativa de envio.
- Preservar lançamentos ao fechar e reabrir.
- Enviar pendências ao reconectar com o app aberto, ao reabri-lo ou pelo botão **Sincronizar**. Há nova tentativa a cada 30 segundos enquanto estiver visível.
- Evitar duplicações com um UUID fixo, inclusive quando a resposta de um envio se perder.

Edição e exclusão de registros já sincronizados, envio de cartinhas e mudanças de foto exigem internet nesta primeira versão. Um envio com resultado incerto precisa ser confirmado antes de permitir edição ou exclusão. O outro celular só vê as novidades após sincronizar.

## Publicar para testar no iPhone

1. Para manter o aplicativo atual disponível, crie outro repositório GitHub e outro projeto Vercel de teste.
2. Envie o **conteúdo** desta pasta: `index.html`, `sw.js`, `desativar-offline.html`, `manifest.webmanifest`, `vercel.json`, `css/`, `js/` e `icons/`. O `index.html` deve ficar na raiz. O Supabase já está configurado na cópia.
3. Importe na Vercel com **Framework: Other**, sem comando de build e sem diretório de saída personalizado.
4. Abra o novo endereço **HTTPS** no Safari e adicione à Tela de Início como **DolarMap Offline**.
5. **Abra pelo novo ícone com internet**, entre na conta e vá a **Ajustes → Sincronização**, logo abaixo de **Conquistas**. Aguarde **Aplicativo preparado para abrir sem internet** e uma **Última atualização** concluída.

Esta cópia usa o MESMO Supabase do app atual. Os gastos que você fizer nesse teste são reais e podem aparecer no app original depois de enviados. Os testes automáticos usam somente dados simulados.

## Teste em modo avião

1. Faça a preparação online pelo ícone.
2. Ative o modo avião e confira que Wi-Fi e dados móveis estão desligados.
3. Feche e abra pelo ícone. Confira saldo e extrato.
4. Cadastre um gasto pequeno chamado **Teste offline**. Ele deve aparecer como **Pendente de sincronização**.
5. Feche e reabra sem internet. O gasto deve continuar lá.
6. Reconecte e mantenha o app aberto. Aguarde a pendência desaparecer ou toque em **Sincronizar**.
7. Confira se o gasto chegou uma única vez ao app original ou ao outro celular. Apague esse registro de teste depois, com internet.

A sincronização ocorre com o app aberto ou ao reabri-lo; não depende de execução com o aplicativo fechado.

## Voltar para DolarMap-publicar

**Se usou outro endereço:** continue usando o ícone/link original. Antes de abandonar o teste, sincronize as pendências que quiser conservar. O app antigo não lê a fila local desta versão.

**Se substituiu no mesmo endereço:**

1. Com internet, sincronize e confira que não há pendências.
2. Abra `https://SEU-ENDERECO/desativar-offline.html` e toque em **Desativar e voltar ao aplicativo**. Essa abertura impede um novo registro do service worker.
3. Publique o conteúdo original de `DolarMap-publicar` pelo GitHub.
4. Feche e reabra pelo endereço normal, sem o parâmetro `offline-desativado`.

A desativação remove só o service worker e os arquivos da interface em cache. Preserva os registros no Supabase e as pendências no IndexedDB. A navegação também consulta a rede primeiro para permitir carregar uma versão anterior publicada no mesmo endereço.

## Armazenamento e contas

- O primeiro login exige internet. A chave de sessão desta versão é `dolarmap.offline.session.v1`.
- Cópias e filas ficam separadas pelo projeto, instalação e ID da conta. Trocar de conta não envia pendências da pessoa anterior.
- Sair preserva as pendências para o próximo login online da mesma conta.
- Não limpe os dados do site nem remova a instalação antes de sincronizar. O armazenamento do navegador não é um backup; o iPhone pode removê-lo em determinadas condições.
- Não é necessário executar SQL ou alterar o banco.

## Verificação local

- `tests/run.html`: testes existentes e testes offline com IndexedDB real.
- `python tools/verify_offline.py`: fluxo completo com Edge/Playwright, servidor local e Supabase simulado. Exige Python, pacote `playwright` e Edge. Não acessa o Supabase real.
- Resultado: `tests/offline-verification.json`. Imagem: `tests/offline-screenshot.png`.
- `python tools/serve.py`: abre em `http://localhost:8765`, usando a configuração real do Supabase; não é o servidor simulado.
- O modo offline exige HTTPS ou `localhost`. Um endereço HTTP da rede local aberto no iPhone não permite preparar o service worker: use o HTTPS da Vercel para o teste no celular.

O fluxo automatizado foi validado no Edge com a rede desabilitada. Ainda precisa ser testado no seu iPhone real.

## Atualizações futuras

Ao alterar esta versão, incremente a versão em `sw.js` e os parâmetros `?v=` de `index.html` e dos imports em `js/`. Mantenha a lista de recursos do service worker completa. Não coloque respostas de login ou do Supabase no cache da interface.
