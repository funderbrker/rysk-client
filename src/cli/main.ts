import { type AppConfig, ConfigError, loadConfig } from '../daemon/config.ts';
import { redactRecord } from '../daemon/logger.ts';
import { type CliCommand, configFlags, parseCli, UsageError } from './args.ts';
import { basisSuggestAnchorCommand } from './basis.ts';
import { historyCommand } from './history.ts';
import { quoteCommand } from './quote.ts';
import { runCommand } from './run.ts';
import { stateCommand } from './state.ts';
import { walletCommand } from './wallet.ts';

/**
 * `rysk <command>` (spec §9.6): parses the command line (a usage error exits 2), loads the config named by
 * `--config` as `configFlags` says (an invalid config exits 1), then runs the command and resolves to its exit
 * code. A command that throws exits 1 with its message on stderr, the RPC URL redacted.
 */
export async function main(argv: string[]): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  let config: AppConfig;
  try {
    config = loadConfig(command.config, configFlags(command));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`rysk ${command.cmd}: ${error.message}\n`);
    return 1;
  }
  try {
    return await dispatch(command, config);
  } catch (error) {
    process.stderr.write(`rysk ${command.cmd}: ${redactedMessage(error, config.rpcUrl)}\n`);
    return 1;
  }
}

function dispatch(command: CliCommand, config: AppConfig): Promise<number> {
  switch (command.cmd) {
    case 'run':
      return runCommand(command, config);
    case 'state':
      return stateCommand(command, config);
    case 'quote':
      return quoteCommand(command, config);
    case 'history':
      return historyCommand(command, config);
    case 'wallet':
      return walletCommand(command, config);
    case 'basis-suggest-anchor':
      return basisSuggestAnchorCommand(command, config);
  }
}

function redactedMessage(error: unknown, rpcUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const { text } = redactRecord({ text: message }, rpcUrl) as { text: string };
  return text;
}

process.exit(await main(process.argv.slice(2)));
