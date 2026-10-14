// Run in the intended contour; does not send messages or start polling.
const args = process.argv.slice(2);
if (args.length && !(args.length === 4 && ['on','off'].includes(args[3]))) {
  console.error('Usage: node scripts/trial-reminders.js [delayHours intervalHours maxMessages on|off]');
  process.exit(2);
}
const { trialReminderSettings,configureTrialReminders } = await import('../src/trial-reminders.js');
const settings = args.length ? configureTrialReminders({delayHours:Number(args[0]),intervalHours:Number(args[1]),maxMessages:Number(args[2]),enabled:args[3]==='on'}) : trialReminderSettings();
console.log(JSON.stringify(settings,null,2));
