import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

const ask = new SlashCommandBuilder().setName('ask').setDescription('Ask Praw a question')
  .addStringOption((o) => o.setName('prompt').setDescription('What do you want to ask?').setRequired(true).setMaxLength(2000));

const remind = new SlashCommandBuilder().setName('remind').setDescription('Reminders')
  .addSubcommand((s) => s.setName('add').setDescription('Set a reminder')
    .addStringOption((o) => o.setName('text').setDescription('What to remind you about').setRequired(true).setMaxLength(500))
    .addIntegerOption((o) => o.setName('minutes').setDescription('Minutes from now').setRequired(true).setMinValue(1).setMaxValue(525600))
    .addIntegerOption((o) => o.setName('every').setDescription('Repeat every N minutes').setMinValue(1).setMaxValue(525600))
    .addIntegerOption((o) => o.setName('advance').setDescription('Also remind N minutes before').setMinValue(0))
    .addBooleanOption((o) => o.setName('dm').setDescription('Send by direct message')))
  .addSubcommand((s) => s.setName('list').setDescription('List your reminders'))
  .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a reminder')
    .addIntegerOption((o) => o.setName('id').setDescription('Reminder id').setRequired(true).setMinValue(1)));

const schedule = new SlashCommandBuilder().setName('schedule').setDescription('Scheduled jobs')
  .addSubcommand((s) => s.setName('add').setDescription('Schedule a prompt (give exactly one of daily, every, at)')
    .addStringOption((o) => o.setName('prompt').setDescription('What Praw should do each time').setRequired(true).setMaxLength(2000))
    .addStringOption((o) => o.setName('daily').setDescription('Every day at HH:MM (schedule time zone)').setMaxLength(5))
    .addIntegerOption((o) => o.setName('every').setDescription('Every N minutes (15 or more)').setMinValue(15).setMaxValue(525600))
    .addStringOption((o) => o.setName('at').setDescription('Once, at an ISO date-time like 2026-11-02T09:00').setMaxLength(40)))
  .addSubcommand((s) => s.setName('list').setDescription('List your scheduled jobs'))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a scheduled job')
    .addIntegerOption((o) => o.setName('id').setDescription('Schedule id').setRequired(true).setMinValue(1)));

const watch = new SlashCommandBuilder().setName('watch').setDescription('Watch a page or topic for changes')
  .addSubcommand((s) => s.setName('add').setDescription('Start watching (posts here when something changes)')
    .addStringOption((o) => o.setName('kind').setDescription('A page url or a search topic').setRequired(true).addChoices({ name: 'url', value: 'url' }, { name: 'topic', value: 'topic' }))
    .addStringOption((o) => o.setName('target').setDescription('The http(s) url, or the topic words').setRequired(true).setMaxLength(2000))
    .addIntegerOption((o) => o.setName('every').setDescription('Check every N minutes (15 or more)').setRequired(true).setMinValue(15).setMaxValue(525600)))
  .addSubcommand((s) => s.setName('list').setDescription('List your watches'))
  .addSubcommand((s) => s.setName('remove').setDescription('Stop a watch')
    .addIntegerOption((o) => o.setName('id').setDescription('Watch id').setRequired(true).setMinValue(1)));

const lesson = new SlashCommandBuilder().setName('lesson').setDescription('Lessons Praw remembers (changes need Bot Admin)')
  .addSubcommand((s) => s.setName('add').setDescription('Add a lesson (Bot Admin)')
    .addStringOption((o) => o.setName('text').setDescription('The lesson (500 characters at most)').setRequired(true).setMaxLength(500)))
  .addSubcommand((s) => s.setName('list').setDescription('List the active lessons'))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a lesson (Bot Admin)')
    .addIntegerOption((o) => o.setName('id').setDescription('Lesson id').setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName('enable').setDescription('Switch a lesson on, e.g. an imported one (Bot Admin)')
    .addIntegerOption((o) => o.setName('id').setDescription('Lesson id').setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName('disable').setDescription('Switch a lesson off (Bot Admin)')
    .addIntegerOption((o) => o.setName('id').setDescription('Lesson id').setRequired(true).setMinValue(1)));

const ocr = new SlashCommandBuilder().setName('ocr').setDescription('Read the text in an image or PDF')
  .addAttachmentOption((o) => o.setName('file').setDescription('PNG, JPEG, WebP or PDF, up to 10 MB').setRequired(true))
  .addStringOption((o) => o.setName('language').setDescription('Main language of the text').addChoices({ name: 'Thai', value: 'th' }, { name: 'English', value: 'en' }, { name: 'Auto', value: 'auto' }));

const receipt = new SlashCommandBuilder().setName('receipt').setDescription('Read a receipt into a table and a CSV file')
  .addAttachmentOption((o) => o.setName('file').setDescription('PNG, JPEG, WebP or PDF, up to 10 MB').setRequired(true));

const play = new SlashCommandBuilder().setName('play').setDescription('Play music in your voice channel (Praw joins it)')
  .addStringOption((o) => o.setName('query').setDescription('A song name to search on YouTube, or a YouTube link').setRequired(true).setMaxLength(300));
const skip = new SlashCommandBuilder().setName('skip').setDescription('Skip the song that is playing');
const queue = new SlashCommandBuilder().setName('queue').setDescription('Show the music queue');
const stop = new SlashCommandBuilder().setName('stop').setDescription('Stop the music and clear the queue');
const volume = new SlashCommandBuilder().setName('volume').setDescription('Set the music volume')
  .addIntegerOption((o) => o.setName('percent').setDescription('0 to 150').setRequired(true).setMinValue(0).setMaxValue(150));

const voice = new SlashCommandBuilder().setName('voice').setDescription('Talk with Praw in your voice channel (audio goes to Google)')
  .addSubcommand((s) => s.setName('join').setDescription('Praw joins your voice channel and listens to you'))
  .addSubcommand((s) => s.setName('leave').setDescription('Praw leaves the voice channel'));

/**
 * Praw's own application commands (R7): registered on Praw's client only; the config COMMANDS never are. Later tasks append.
 * Any member may use them (no admin gate, except /lesson changes which the handler restricts); guild-only.
 */
export const PRAW_COMMANDS = [ask, remind, schedule, watch, lesson, ocr, receipt, play, skip, queue, stop, volume, voice].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());
