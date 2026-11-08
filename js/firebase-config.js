/*
 * Configuração do Firebase — histórico partilhado do #guimaraes.
 *
 * A apiKey do Firebase NÃO é secreta: é pública por design e vai sempre no
 * código do site. O que protege os dados são as regras da Realtime Database
 * (ver README, secção "Firebase").
 *
 * Se quiseres desligar o histórico na nuvem, põe enabled: false.
 */
window.FIREBASE_CONFIG = {
  enabled: true,
  databaseURL: 'https://guimaraes-ptnet-default-rtdb.europe-west1.firebasedatabase.app',
  channel: '#guimaraes',
  limit: 500,
};
