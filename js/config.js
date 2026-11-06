// Configuração pública do app.
//
// Enquanto supabaseUrl/supabaseAnonKey estiverem vazios, o app roda em MODO LOCAL
// (sem senha, dados salvos só no aparelho). Preencha para ativar login + sincronização.
//
// A "anon/publishable key" do Supabase é PÚBLICA por design (vai para o navegador de
// qualquer forma). A segurança vem das políticas RLS em supabase/schema.sql.
// NUNCA coloque aqui a "service_role"/"secret key".
export const CONFIG = {
  supabaseUrl: 'https://qknxwirmzfcieoyrwxpv.supabase.co',
  supabaseAnonKey: 'sb_publishable_jiX9Mmbzo9jkZ6Ysb-fjyw_Z1KPnm7Y',

  // Login por nome: cada pessoa usa o "email" definido abaixo no Supabase.
  // Se "email" for omitido, usa "<username>@<emailDomain>".
  // Atenção: estes e-mails ficam visíveis no código do site publicado.
  emailDomain: 'dolarmap.app',

  users: [
    { username: 'gustavo', name: 'Gustavo', color: '#0A84FF', email: 'gustavinhongarcia@gmail.com' },
    { username: 'manuela', name: 'Manuela', color: '#FF375F', email: 'manuelacontreiras2006@gmail.com' },
  ],

  // Cartinha secreta 💌 (toque em "DolarMap 1.0" no fim de Ajustes).
  // Funciona para os dois: cada um envia para o outro.
  // MODO TESTE: com true, a cartinha também abre na tela de quem enviou.
  // false = aparece só na tela de quem recebe.
  loveNoteEchoToSender: false,
};
