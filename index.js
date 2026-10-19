require('dotenv').config({ path: require('path').join(__dirname, '.env') });
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';

const fs = require('fs');
const path = require('path');

const {
    Client,
    GatewayIntentBits,
    PermissionFlagsBits,
    SlashCommandBuilder,
    REST,
    Routes,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType
} = require('@discordjs/voice');

const { spawn } = require('child_process');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');

// play-dl yerine yt-dlp kullaniyoruz (play-dl YouTube'un yeni formatlarinda
// siklikla "Invalid URL" gibi hatalar veriyor ve artik guvenilir degil).
// Sunucuda yt-dlp kurulu olmali: sudo apt install -y yt-dlp  (veya: pip install -U yt-dlp)
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';

function ytdlpJson(url) {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, ['--dump-json', '--no-playlist', '--no-warnings', url]);
        let out = '';
        let err = '';
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => {
            if (code !== 0 || !out) {
                return reject(new Error('yt-dlp bilgi alamadi: ' + (err.trim().split('\n')[0] || 'bilinmeyen hata')));
            }
            try {
                resolve(JSON.parse(out));
            } catch {
                reject(new Error('yt-dlp ciktisi okunamadi'));
            }
        });
        proc.on('error', e => reject(new Error('yt-dlp calistirilamadi (kurulu mu?): ' + e.message)));
    });
}

function createYtdlpAudioStream(url) {
    const ytdlpProc = spawn(YTDLP_PATH, [
        '-o', '-',
        '-f', 'bestaudio[ext=webm]/bestaudio/best',
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const ffmpegProc = spawn(FFMPEG_BIN, [
        '-i', 'pipe:0',
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ytdlpProc.stdout.pipe(ffmpegProc.stdin);

    let ytdlpErr = '';
    ytdlpProc.stderr.on('data', d => ytdlpErr += d);
    ytdlpProc.on('error', e => console.error('yt-dlp baslatilamadi:', e.message));
    ytdlpProc.on('close', code => {
        if (code !== 0 && ytdlpErr) console.error('yt-dlp stream hatasi:', ytdlpErr.trim().split('\n')[0]);
        try { ffmpegProc.stdin.end(); } catch {}
    });
    ffmpegProc.on('error', e => console.error('ffmpeg hatasi:', e.message));

    ffmpegProc._cleanup = () => {
        try { ytdlpProc.kill('SIGKILL'); } catch {}
        try { ffmpegProc.kill('SIGKILL'); } catch {}
    };

    return ffmpegProc;
}

// === ÖNEMLİ: Bu bilgiler artık .env dosyasından okunuyor ===
// Proje klasöründe ".env" adlı bir dosya oluştur ve içine şunları yaz:
//
// DISCORD_TOKEN=yeni_token_buraya
// CLIENT_ID=uygulama_id_buraya
// SPOTIFY_CLIENT_ID=spotify_client_id_buraya
// SPOTIFY_CLIENT_SECRET=spotify_client_secret_buraya
//
// Eski token ve Spotify secret'ını Discord Developer Portal ve
// Spotify Developer Dashboard üzerinden YENİLEMEDEN bu botu tekrar
// yayına alma — eski bilgiler ifşa oldu.

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!TOKEN || !CLIENT_ID) {
    console.error('HATA: .env dosyasinda DISCORD_TOKEN veya CLIENT_ID eksik!');
    process.exit(1);
}

// ================== YENİ: YETKİLİ ÇIKARMA ROLÜ SİSTEMİ ==================
// Bu role sahip kisi /cik komutunu kullandiginda oylama yapilmaz, bot aninda
// kanaldan cikar. /cik komutunda "dakika" parametresiyle sure secilebilir
// (belirtilmezse varsayilan 5 dakika). Bu sure SADECE o ses kanalina tekrar
// girilmesini engeller, baska bir kanala bot hemen cagirilabilir.
const KICK_ROLES_FILE = path.join(__dirname, 'kick_roles.json');
const DEFAULT_KICK_COOLDOWN_MS = 5 * 60 * 1000; // 5 dakika

function loadKickRoles() {
    try {
        return JSON.parse(fs.readFileSync(KICK_ROLES_FILE, 'utf8'));
    } catch {
        return {};
    }
}
function saveKickRoles(data) {
    try {
        fs.writeFileSync(KICK_ROLES_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('kick_roles.json yazilamadi:', err.message);
    }
}

const kickRoles = loadKickRoles(); // { guildId: roleId }
const channelCooldowns = new Map(); // channelId -> bu zamana kadar (ms) bu KANALA tekrar girilemez

function getChannelCooldownRemainingMs(channelId) {
    const until = channelCooldowns.get(channelId);
    if (!until) return 0;
    const remaining = until - Date.now();
    return remaining > 0 ? remaining : 0;
}
function formatMs(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ' dk ' + s + ' sn';
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});

const spotifyApi = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET
});

async function refreshSpotifyToken() {
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        console.warn('Spotify bilgileri eksik, Spotify linkleri calismayacak.');
        return;
    }
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body['access_token']);
        setTimeout(refreshSpotifyToken, (data.body['expires_in'] - 60) * 1000);
    } catch (err) {
        console.error('Spotify token hatasi:', err);
        setTimeout(refreshSpotifyToken, 60000);
    }
}

const queues = new Map();

function getOrCreateQueue(guildId) {
    if (!queues.has(guildId)) {
        queues.set(guildId, {
            songs: [],
            player: null,
            connection: null,
            volume: 100,
            textChannel: null
        });
    }
    return queues.get(guildId);
}

function isYouTubeUrl(url) {
    return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
}

function getSpotifyType(url) {
    if (!url.includes('spotify.com')) return null;
    if (url.includes('/playlist/')) return 'playlist';
    if (url.includes('/track/')) return 'track';
    if (url.includes('/album/')) return 'album';
    return null;
}

function extractSpotifyId(url) {
    const match = url.match(/\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
    return match ? { type: match[1], id: match[2] } : null;
}

async function searchYouTube(query) {
    const result = await ytSearch(query);
    if (!result || !result.videos || result.videos.length === 0) return null;
    const video = result.videos[0];
    return {
        title: video.title,
        url: video.url,
        duration: video.timestamp,
        thumbnail: video.thumbnail
    };
}

async function getYouTubeInfo(url) {
    try {
        const data = await ytdlpJson(url);
        return {
            title: data.title,
            url: data.webpage_url || url,
            duration: formatDuration(Math.round(data.duration || 0)),
            thumbnail: data.thumbnail
        };
    } catch (err) {
        console.error('YouTube info hatasi:', err.message);
        return null;
    }
}

async function spotifyTrackToYoutube(trackId) {
    const data = await spotifyApi.getTrack(trackId);
    const track = data.body;
    const query = track.name + ' ' + track.artists.map(a => a.name).join(' ');
    return await searchYouTube(query);
}

async function getSpotifyPlaylist(playlistId) {
    const songs = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total && offset < 50) {
        const data = await spotifyApi.getPlaylistTracks(playlistId, { offset, limit: 25 });
        total = data.body.total;
        for (const item of data.body.items) {
            if (!item.track) continue;
            const query = item.track.name + ' ' + item.track.artists.map(a => a.name).join(' ');
            songs.push({ searchQuery: query, title: item.track.name + ' - ' + item.track.artists[0].name });
        }
        offset += 25;
    }
    return songs;
}

async function getSpotifyAlbum(albumId) {
    const songs = [];
    const data = await spotifyApi.getAlbumTracks(albumId, { limit: 50 });
    for (const track of data.body.items) {
        const query = track.name + ' ' + track.artists.map(a => a.name).join(' ');
        songs.push({ searchQuery: query, title: track.name + ' - ' + track.artists[0].name });
    }
    return songs;
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + s.toString().padStart(2, '0');
}

// === yt-dlp + ffmpeg borusu kullaniyor, play-dl yok ===
async function createResource(url, volume) {
    const ffmpegProc = createYtdlpAudioStream(url);
    const resource = createAudioResource(ffmpegProc.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
    });
    resource.volume.setVolume((volume || 100) / 100);
    resource._processCleanup = ffmpegProc._cleanup;
    return resource;
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue) return;

    if (queue.songs.length === 0) {
        if (queue.textChannel) {
            queue.textChannel.send({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Kuyruk bitti! Cikiyorum...')]
            }).catch(() => {});
        }
        // === DÜZELTİ: artik 30sn beklemiyor, mesajla ayni anda hemen cikiyor ===
        if (queue.connection) queue.connection.destroy();
        queues.delete(guildId);
        return;
    }

    const song = queue.songs[0];

    if (song.searchQuery && !song.url) {
        const found = await searchYouTube(song.searchQuery);
        if (!found) {
            queue.songs.shift();
            return playNext(guildId);
        }
        song.url = found.url;
        song.duration = found.duration;
        song.thumbnail = found.thumbnail;
    }

    try {
        const resource = await createResource(song.url, queue.volume);
        queue.currentCleanup = resource._processCleanup || null;
        queue.player.play(resource);

        if (queue.textChannel) {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Simdi Oynatiliyor')
                .setDescription('[' + song.title + '](' + song.url + ')')
                .addFields(
                    { name: 'Sure', value: song.duration || '?', inline: true },
                    { name: 'Ses', value: queue.volume + '%', inline: true },
                    { name: 'Kuyruk', value: (queue.songs.length - 1) + ' sarki', inline: true }
                )
                .setTimestamp();
            if (song.thumbnail) embed.setThumbnail(song.thumbnail);
            queue.textChannel.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (err) {
        console.error('Oynatma hatasi:', err);
        if (queue.textChannel) {
            queue.textChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('Calma Hatasi')
                    .setDescription('**' + song.title + '** calinamadi, atlaniyor.\n`' + err.message + '`')
                ]
            }).catch(() => {});
        }
        queue.songs.shift();
        playNext(guildId);
    }
}

async function connectAndPlay(guildId, voiceChannel) {
    const queue = getOrCreateQueue(guildId);

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
    });

    queue.connection = connection;

    connection.on('debug', m => console.log('[VOICE DEBUG]', m));
    connection.on('stateChange', (oldState, newState) => {
        console.log('[VOICE STATE]', oldState.status, '->', newState.status);
    });

    const player = createAudioPlayer();
    queue.player = player;
    connection.subscribe(player);

    // === DÜZELTİ: bu olay artik TEK kaynaktan ileri sarma yapiyor.
    // /gec komutu artik burada manuel shift yapmiyor, sadece player.stop() cagiriyor;
    // shift + cleanup + playNext SADECE burada gerceklesiyor. Bu sayede /gec kullanildiginda
    // 2 sarki birden atlanma hatasi cozuldu.
    player.on(AudioPlayerStatus.Idle, () => {
        if (queue.currentCleanup) { queue.currentCleanup(); queue.currentCleanup = null; }
        queue.songs.shift();
        playNext(guildId);
    });

    player.on('error', err => {
        console.error('Player hatasi:', err);
        if (queue.textChannel) {
            queue.textChannel.send('Ses oynatici hatasi: `' + err.message + '`').catch(() => {});
        }
        if (queue.currentCleanup) { queue.currentCleanup(); queue.currentCleanup = null; }
        queue.songs.shift();
        playNext(guildId);
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30000);
        await playNext(guildId);
    } catch (err) {
        console.error('Baglanti hatasi:', err);
        if (queue.textChannel) {
            queue.textChannel.send('Sesli kanala baglanilamadi: `' + err.message + '`').catch(() => {});
        }
        connection.destroy();
        queues.delete(guildId);
    }

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5000)
            ]);
        } catch {
            connection.destroy();
            queues.delete(guildId);
        }
    });
}

async function addToQueue(interaction, voiceChannel, song) {
    const guildId = interaction.guildId;
    const queue = getOrCreateQueue(guildId);
    queue.textChannel = interaction.channel;
    queue.songs.push(song);

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(queue.songs.length === 1 ? 'Caliniyor' : 'Kuyruga Eklendi')
        .setDescription('[' + song.title + '](' + song.url + ')')
        .addFields(
            { name: 'Sure', value: song.duration || '?', inline: true },
            { name: 'Sira', value: queue.songs.length + '. sirada', inline: true }
        );
    if (song.thumbnail) embed.setThumbnail(song.thumbnail);

    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
        await connectAndPlay(guildId, voiceChannel);
    }

    try {
        await interaction.editReply({ embeds: [embed] });
    } catch {
        try { await interaction.followUp({ embeds: [embed] }); } catch {}
    }
}

async function addToQueueRaw(interaction, voiceChannel, song) {
    const guildId = interaction.guildId;
    const queue = getOrCreateQueue(guildId);
    queue.textChannel = interaction.channel;
    queue.songs.push(song);

    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
        await connectAndPlay(guildId, voiceChannel);
    }
}

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('dinle')
            .setDescription('Muzik cal veya kuyruga ekle')
            .addSubcommand(sub =>
                sub.setName('ara')
                    .setDescription('Isme gore sarki ara')
                    .addStringOption(opt =>
                        opt.setName('sorgu').setDescription('Sarki adi').setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('link')
                    .setDescription('YouTube veya Spotify linki ile cal')
                    .addStringOption(opt =>
                        opt.setName('url').setDescription('YouTube/Spotify linki').setRequired(true)
                    )
            ),
        new SlashCommandBuilder()
            .setName('ses')
            .setDescription('Ses seviyesini ayarla (0-100)')
            .addIntegerOption(opt =>
                opt.setName('seviye').setDescription('Ses seviyesi').setRequired(true).setMinValue(0).setMaxValue(100)
            ),
        new SlashCommandBuilder().setName('dur').setDescription('Muzigi durdur/devam ettir'),
        new SlashCommandBuilder().setName('gec').setDescription('Bir sonraki sarkiya gec'),
        new SlashCommandBuilder().setName('kuyruk').setDescription('Kuyrugu goster'),
        new SlashCommandBuilder()
            .setName('cik')
            .setDescription('Botu kanaldan cikar (yetkili rolu varsa aninda + sure secebilirsin, yoksa oylama ile)')
            .addIntegerOption(opt =>
                opt.setName('dakika')
                    .setDescription('Bu kanala kac dakika girilemesin? (sadece yetkili rolu icin, belirtilmezse 5)')
                    .setRequired(false)
                    .setMinValue(1)
                    .setMaxValue(1440)
            ),
        new SlashCommandBuilder().setName('temizle').setDescription('Kurugu temizle'),
        // === YENİ: yetkili çıkarma rolü ayar komutu ===
        new SlashCommandBuilder()
            .setName('botyetkili')
            .setDescription('Botu oylamasiz aninda cikarabilecek rolu ayarlar (Yonetici)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub =>
                sub.setName('ayarla')
                    .setDescription('Yetkili rolu ayarla')
                    .addRoleOption(opt => opt.setName('rol').setDescription('Rol').setRequired(true))
            )
            .addSubcommand(sub => sub.setName('kaldir').setDescription('Yetkili rolu kaldirir'))
            .addSubcommand(sub => sub.setName('goster').setDescription('Mevcut yetkili rolu gosterir'))
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash komutlari kaydedildi!');
}

client.once('ready', async () => {
    console.log(client.user.tag + ' olarak giris yapildi! Bot aktif.');
    await refreshSpotifyToken();
    await registerCommands();
    client.user.setActivity('🎵 /dinle', { type: 2 });
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            await handleCommand(interaction);
        }
    } catch (err) {
        console.error('Interaction hatasi:', err);
    }
});

async function handleCommand(interaction) {
    const { commandName } = interaction;

    // === YENİ: yetkili rol ayar komutu ===
    if (commandName === 'botyetkili') {
        const sub = interaction.options.getSubcommand();
        const gid = interaction.guildId;

        if (sub === 'ayarla') {
            const role = interaction.options.getRole('rol', true);
            kickRoles[gid] = role.id;
            saveKickRoles(kickRoles);
            return interaction.reply({
                content: '✅ Artik **' + role.name + '** rolune sahip kisiler `/cik` ile botu oylamasiz, aninda cikarabilir.',
                ephemeral: true
            });
        }
        if (sub === 'kaldir') {
            delete kickRoles[gid];
            saveKickRoles(kickRoles);
            return interaction.reply({ content: '✅ Yetkili rol kaldirildi, artik herkes icin oylama gerekecek.', ephemeral: true });
        }
        if (sub === 'goster') {
            const roleId = kickRoles[gid];
            return interaction.reply({
                content: roleId ? '👑 Yetkili rol: <@&' + roleId + '>' : 'ℹ️ Henuz bir yetkili rol ayarlanmadi.',
                ephemeral: true
            });
        }
        return;
    }

    if (commandName === 'dinle') {
        const sub = interaction.options.getSubcommand();
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: 'Once bir ses kanalina gir!', ephemeral: true });
        }

        // === YENİ: bu KANAL icin yetkili tarafindan cikarildiktan sonraki bekleme kontrolu ===
        // (sadece bu kanal icin gecerli, baska bir kanala hemen cagirilabilir)
        const remainingMs = getChannelCooldownRemainingMs(voiceChannel.id);
        if (remainingMs > 0) {
            return interaction.reply({
                content: '⏳ Bot bu kanaldan az once yetkili biri tarafindan cikarildi. Bu kanala **' + formatMs(remainingMs) + '** sonra tekrar girebilir. (Baska bir kanala hemen cagirabilirsin.)',
                ephemeral: true
            });
        }

        if (sub === 'ara') {
            const query = interaction.options.getString('sorgu');
            await interaction.deferReply();

            const results = await ytSearch(query);
            if (!results || results.videos.length === 0) {
                return interaction.editReply('Hicbir sey bulunamadi!');
            }

            const top5 = results.videos.slice(0, 5);
            const options = top5.map(v => ({
                label: v.title.slice(0, 99),
                description: (v.timestamp + ' - ' + v.author.name).slice(0, 99),
                value: v.url
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('song_select')
                .setPlaceholder('Bir sarki sec...')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('"' + query + '" icin sonuclar')
                .setDescription(top5.map((v, i) => (i + 1) + '. ' + v.title + ' - ' + v.timestamp).join('\n'));

            await interaction.editReply({ embeds: [embed], components: [row] });

            const collector = interaction.channel.createMessageComponentCollector({
                filter: i => i.customId === 'song_select' && i.user.id === interaction.user.id,
                time: 60000,
                max: 1
            });

            collector.on('collect', async i => {
                const url = i.values[0];
                const song = await getYouTubeInfo(url);
                if (!song) return i.reply({ content: 'Sarki bilgisi alinamadi.', ephemeral: true });
                await i.update({ components: [] });
                await addToQueue(interaction, voiceChannel, song);
            });

            collector.on('end', collected => {
                if (collected.size === 0) {
                    interaction.editReply({ content: 'Sure doldu, secim yapilmadi.', components: [], embeds: [] }).catch(() => {});
                }
            });
        }

        if (sub === 'link') {
            const url = interaction.options.getString('url');
            await interaction.deferReply();

            const spotifyType = getSpotifyType(url);

            if (spotifyType) {
                const info = extractSpotifyId(url);
                if (!info) return interaction.editReply('Gecersiz Spotify linki!');

                try {
                    if (info.type === 'track') {
                        const song = await spotifyTrackToYoutube(info.id);
                        if (!song) return interaction.editReply('Sarki bulunamadi!');
                        await addToQueue(interaction, voiceChannel, song);
                    } else if (info.type === 'playlist') {
                        const songs = await getSpotifyPlaylist(info.id);
                        await interaction.editReply('Spotify playlistten ' + songs.length + ' sarki kuyruga ekleniyor...');
                        for (const s of songs) await addToQueueRaw(interaction, voiceChannel, s);
                    } else if (info.type === 'album') {
                        const songs = await getSpotifyAlbum(info.id);
                        await interaction.editReply('Spotify albumunden ' + songs.length + ' sarki kuyruga ekleniyor...');
                        for (const s of songs) await addToQueueRaw(interaction, voiceChannel, s);
                    }
                } catch (err) {
                    console.error('Spotify hatasi:', err);
                    interaction.editReply('Spotify islenirken hata olustu: ' + err.message).catch(() => {});
                }
            } else if (isYouTubeUrl(url)) {
                const song = await getYouTubeInfo(url);
                if (!song) return interaction.editReply('Video bilgisi alinamadi!');
                await addToQueue(interaction, voiceChannel, song);
            } else {
                const song = await searchYouTube(url);
                if (!song) return interaction.editReply('Hicbir sey bulunamadi!');
                await addToQueue(interaction, voiceChannel, song);
            }
        }
    }

    if (commandName === 'ses') {
        const seviye = interaction.options.getInteger('seviye');
        const queue = queues.get(interaction.guildId);
        if (!queue || !queue.player) {
            return interaction.reply({ content: 'Su an muzik calmiyor!', ephemeral: true });
        }
        queue.volume = seviye;
        try {
            const res = queue.player.state?.resource;
            if (res?.volume) res.volume.setVolume(seviye / 100);
        } catch {}
        const bar = '█'.repeat(Math.round(seviye / 10)) + '░'.repeat(10 - Math.round(seviye / 10));
        interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Ses: **' + seviye + '%**\n`' + bar + '`')]
        });
    }

    if (commandName === 'dur') {
        const queue = queues.get(interaction.guildId);
        if (!queue?.player) return interaction.reply({ content: 'Muzik calmiyor!', ephemeral: true });
        if (queue.player.state.status === AudioPlayerStatus.Paused) {
            queue.player.unpause();
            interaction.reply('Muzik devam ediyor.');
        } else {
            queue.player.pause();
            interaction.reply('Muzik duraklatildi.');
        }
    }

    if (commandName === 'gec') {
        const queue = queues.get(interaction.guildId);
        if (!queue?.player || queue.songs.length === 0) {
            return interaction.reply({ content: 'Kuyruk bos!', ephemeral: true });
        }
        // === DÜZELTİ: artik burada elle shift/cleanup YAPMIYORUZ.
        // player.stop() zaten AudioPlayerStatus.Idle olayini tetikler ve o olay
        // cleanup + shift + playNext islemini TEK bir yerden (connectAndPlay icindeki
        // Idle listener) yapar. Eskiden burada da elle shift yapiliyordu, bu da Idle
        // olayinin BIR DAHA shift yapmasina (yani 2 sarki birden atlanmasina) sebep
        // oluyordu — /gec calismiyor gibi gorunmesinin sebebi buydu.
        queue.player.stop();
        interaction.reply('Sonraki sarkiya gecildi.');
    }

    if (commandName === 'kuyruk') {
        const queue = queues.get(interaction.guildId);
        if (!queue || queue.songs.length === 0) {
            return interaction.reply({ content: 'Kuyruk bos!', ephemeral: true });
        }
        const list = queue.songs.slice(0, 10).map((s, i) =>
            (i === 0 ? '▶️' : '`' + i + '.`') + ' **' + s.title + '** ' + (s.duration ? '`' + s.duration + '`' : '')
        ).join('\n');
        interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Kuyruk (' + queue.songs.length + ' sarki)')
                .setDescription(list + (queue.songs.length > 10 ? '\n\n...ve ' + (queue.songs.length - 10) + ' sarki daha' : ''))
                .addFields({ name: 'Ses', value: queue.volume + '%', inline: true })
            ]
        });
    }

    if (commandName === 'temizle') {
        const queue = queues.get(interaction.guildId);
        if (!queue) return interaction.reply({ content: 'Kuyruk zaten bos!', ephemeral: true });
        const current = queue.songs[0];
        queue.songs = current ? [current] : [];
        interaction.reply('Kuyruk temizlendi! Suan calanan sarki devam ediyor.');
    }

    if (commandName === 'cik') {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: 'Ses kanalinda degilsin!', ephemeral: true });
        }
        const queue = queues.get(interaction.guildId);
        if (!queue?.connection) {
            return interaction.reply({ content: 'Bot zaten ses kanalinda degil!', ephemeral: true });
        }
        const botChannel = interaction.guild.members.me?.voice?.channel;
        if (!botChannel || botChannel.id !== voiceChannel.id) {
            return interaction.reply({ content: 'Botla ayni ses kanalinda degilsin!', ephemeral: true });
        }

        // === YENİ: yetkili rol kontrolu - varsa oylamasiz aninda cikar + SADECE BU KANALA secilen sure kadar girememe ===
        const privilegedRoleId = kickRoles[interaction.guildId];
        if (privilegedRoleId && interaction.member.roles.cache.has(privilegedRoleId)) {
            const customMinutes = interaction.options.getInteger('dakika');
            const cooldownMs = customMinutes ? customMinutes * 60 * 1000 : DEFAULT_KICK_COOLDOWN_MS;
            if (queue.currentCleanup) queue.currentCleanup();
            queue.connection.destroy();
            queues.delete(interaction.guildId);
            channelCooldowns.set(voiceChannel.id, Date.now() + cooldownMs);
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('👑 Yetkili Cikarma')
                    .setDescription(interaction.user.displayName + ' yetkili rolu ile botu aninda **' + voiceChannel.name + '** kanalindan cikardi.\nBot **' + formatMs(cooldownMs) + '** boyunca SADECE bu kanala tekrar giremeyecek (baska bir kanala hemen cagirilabilir).')
                ]
            });
        }

        const members = voiceChannel.members.filter(m => !m.user.bot);
        const memberCount = members.size;
        const needed = Math.ceil(memberCount / 2);

        if (memberCount <= 1) {
            if (queue.currentCleanup) queue.currentCleanup();
            queue.connection.destroy();
            queues.delete(interaction.guildId);
            return interaction.reply('Kanaldan ayrildi!');
        }

        const voteSet = new Set([interaction.user.id]);
        const stayVotes = new Set();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vote_yes').setLabel('Gitsin (1/' + needed + ')').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('vote_no').setLabel('Kalsin (0/' + needed + ')').setStyle(ButtonStyle.Success)
        );

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('Bot Cikis Oylamasi')
            .setDescription(interaction.user.displayName + ' botu cikarmayi istiyor!\nCogunluk icin ' + needed + '/' + memberCount + ' oy gerekli.\nGitsin: 1 | Kalsin: 0')
            .setFooter({ text: '60 saniye icinde oy kullanin' });

        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

        const collector = msg.createMessageComponentCollector({
            filter: i => (i.customId === 'vote_yes' || i.customId === 'vote_no') && voiceChannel.members.has(i.user.id) && !i.user.bot,
            time: 60000
        });

        collector.on('collect', async i => {
            if (i.customId === 'vote_yes') { voteSet.add(i.user.id); stayVotes.delete(i.user.id); }
            else { stayVotes.add(i.user.id); voteSet.delete(i.user.id); }

            const goCount = voteSet.size;
            const stayCount = stayVotes.size;
            const cur = voiceChannel.members.filter(m => !m.user.bot).size;
            const curNeeded = Math.ceil(cur / 2);

            const updRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vote_yes').setLabel('Gitsin (' + goCount + '/' + curNeeded + ')').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('vote_no').setLabel('Kalsin (' + stayCount + '/' + curNeeded + ')').setStyle(ButtonStyle.Success)
            );
            const updEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('Bot Cikis Oylamasi')
                .setDescription('Cogunluk icin ' + curNeeded + '/' + cur + ' oy gerekli.\nGitsin: ' + goCount + ' | Kalsin: ' + stayCount)
                .setFooter({ text: '60 saniye icinde oy kullanin' });

            await i.update({ embeds: [updEmbed], components: [updRow] });

            if (goCount >= curNeeded) collector.stop('go');
            else if (stayCount >= curNeeded) collector.stop('stay');
        });

        collector.on('end', async (_, reason) => {
            const q = queues.get(interaction.guildId);
            const disRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vote_yes').setLabel('Gitsin').setStyle(ButtonStyle.Danger).setDisabled(true),
                new ButtonBuilder().setCustomId('vote_no').setLabel('Kalsin').setStyle(ButtonStyle.Success).setDisabled(true)
            );
            if (reason === 'go') {
                await msg.edit({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('Cogunluk saglandi! Bot ayrilıyor...')], components: [disRow] });
                if (q?.connection) { if (q.currentCleanup) q.currentCleanup(); q.connection.destroy(); queues.delete(interaction.guildId); }
            } else if (reason === 'stay') {
                await msg.edit({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('Cogunluk kalmak istiyor! Bot kalıyor.')], components: [disRow] });
            } else {
                const goCount = voteSet.size;
                const cur = voiceChannel.members.filter(m => !m.user.bot).size;
                if (goCount >= Math.ceil(cur / 2)) {
                    await msg.edit({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('Sure doldu. Cogunluk ayrilmak istedi, bot gidiyor.')], components: [disRow] });
                    if (q?.connection) { if (q.currentCleanup) q.currentCleanup(); q.connection.destroy(); queues.delete(interaction.guildId); }
                } else {
                    await msg.edit({ embeds: [new EmbedBuilder().setColor(0x99AAB5).setDescription('Sure doldu. Yeterli oy toplanamadi, bot kalıyor.')], components: [disRow] });
                }
            }
        });
    }
}

client.login(TOKEN);