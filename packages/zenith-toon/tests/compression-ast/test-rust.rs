mod commands;

#[derive(Parser)]
#[command(name = "octomind")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Octomind is a smart AI developer assistant with configurable MCP support")]
struct CliArgs {
	#[command(subcommand)]
	command: Commands,
}

#[derive(Subcommand)]
enum Commands {
	Config(commands::ConfigArgs),

	Run(commands::RunArgs),

	/// Start WebSocket server for remote AI sessions
	Server(commands::ServerArgs),

	/// Run as an ACP (Agent Client Protocol) agent over stdio
	Acp(commands::AcpArgs),

	/// Add a registry tap (agent source URL).
	/// Omit URL to list all active taps.
	Tap(commands::TapArgs),

	/// Remove a previously added registry tap.
	Untap(commands::UntapArgs),

	/// Show all available placeholder variables and their values
	Vars(commands::VarsArgs),

	/// Send a message to a running session by name.
	Send(commands::SendArgs),

	/// Generate shell completion scripts
	Completion {
		/// The shell to generate completion for
		#[arg(value_enum)]
		shell: Shell,
	},

	/// Print completion candidates for a subcommand (used by shell completion scripts).
	/// Outputs one candidate per line to stdout.
	#[command(hide = true)]
	Complete(commands::CompleteArgs),
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
	// Initialize environment tracker before loading .env
	let _tracker = octomind::config::get_env_tracker();

	// Load .env file from current directory (if exists)
	// This will override existing environment variables with .env values
	if let Err(e) = octomind::config::get_env_tracker()
		.lock()
		.unwrap()
		.load_dotenv_override()
	{
		octomind::log_debug!("Failed to load .env file: {}", e);
	}
 # ... [lines 91-96 omitted]
	let args = CliArgs::parse();

	// Set process/terminal title for long-running subcommands so they're
	// self-identifying in `ps` and terminal tabs. `Run` is handled later in
	// the session main loop once the session ID is known.
	match &args.command {
		Commands::Acp(_) => octomind::proctitle::set_process_title("octomind-acp"),
		Commands::Server(_) => {
			octomind::proctitle::set_process_title("octomind-server");
			octomind::proctitle::set_terminal_title("octomind-server");
		}
		_ => {}
	}

	// Load configuration
	let config = Config::load()?;

	// Setup cleanup for MCP server processes when the program exits
	let result = run_with_cleanup(args, config).await;

	// Make sure to clean up any started server processes
	if let Err(e) = octomind::mcp::server::cleanup_servers() {
		octomind::log_error!("Warning: Error cleaning up MCP servers: {}", e);
	}

	result
}

async fn run_with_cleanup(args: CliArgs, config: Config) -> Result<(), anyhow::Error> {
	let log_level = config.log_level.as_str();
	if let Commands::Run(_) = &args.command {
		if let Err(e) = octomind::logging::tracing_setup::init_tracing(
			octomind::logging::tracing_setup::LoggingMode::Cli,
			log_level,
		) {
			eprintln!("Warning: Failed to initialize tracing: {e}");
		}
	}

	let sandbox_enabled = match &args.command {
		Commands::Run(a) => config.sandbox || a.sandbox,
		Commands::Server(a) => config.sandbox || a.sandbox,
		Commands::Acp(a) => config.sandbox || a.sandbox,
		_ => false,
	};
	if sandbox_enabled {
		let cwd = std::env::current_dir()?;
		octomind::sandbox::apply(&cwd)?;
	}

	match args.command {
		Commands::Config(config_args) => commands::config::execute(&config_args, config)?,
		Commands::Run(run_args) => commands::run::execute(&run_args, &config).await?,
		Commands::Server(server_args) => commands::server::execute(&server_args, &config).await?,
		Commands::Acp(acp_args) => commands::acp::execute(&acp_args, &config).await?,
		Commands::Tap(tap_args) => commands::tap::execute(&tap_args)?,
		Commands::Untap(untap_args) => commands::untap::execute(&untap_args)?,
		Commands::Vars(vars_args) => commands::vars::execute(&vars_args, &config).await?,
		Commands::Send(send_args) => commands::send::execute(&send_args).await?,
		Commands::Completion { shell } => {
			let mut app = CliArgs::command();
			let name = app.get_name().to_string();
			let mut buf = Vec::new();
			generate(shell, &mut app, &name, &mut buf);
			let script = String::from_utf8_lossy(&buf);
			let patched = patch_completion_script(&script, shell);
			print!("{patched}");
		}
		Commands::Complete(complete_args) => commands::complete::execute(&complete_args, &config)?,
	}

	Ok(())
}

/// Patch the clap-generated completion script to add dynamic TAG completions
/// for `octomind run` by calling `octomind complete run` at runtime.
fn patch_completion_script(script: &str, shell: Shell) -> String {
	match shell {
		Shell::Bash => patch_bash(script),
		Shell::Zsh => patch_zsh(script),
		Shell::Fish => patch_fish(script),
		// PowerShell and Elvish: emit as-is (no dynamic patching needed for now)
		_ => script.to_string(),
	}
# ... [lines 181-192 omitted]
///    as a completion candidate when typing flags.
fn patch_bash(script: &str) -> String {
	// The case label uses 8 spaces of indentation in the clap output.
	let marker = "        octomind__run)\n";
	let Some(run_pos) = script.find(marker) else {
		return script.to_string();
	};
	let block_start = run_pos + marker.len();

	// Find the end of this block: next case label at the same indent level.
	let end_marker = "\n        octomind__";
	let block_len = script[block_start..]
		.find(end_marker)
		.unwrap_or(script.len() - block_start);
	let block_end = block_start + block_len;

	let block = &script[block_start..block_end];

  # ... [lines 211-222 omitted]
		"                    COMPREPLY=($(compgen -W \"$(octomind complete run 2>/dev/null)\" -- \"${cur}\"))\n                    return 0\n                    ;;\n",
	);

	format!(
		"{}{}{}{}",
		&script[..run_pos],
		marker,
		block,
		&script[block_end..]
	)
}

fn patch_zsh(script: &str) -> String {
 # ... [lines 238-246 omitted]
	let helper = "\n_octomind_complete_run() {\n  local -a tags\n  tags=(${(f)\"$(octomind complete run 2>/dev/null)\"})\n  compadd -a tags\n}\n";

	// Find the end of the first line (#compdef octomind).
	let after_first_line = script.find('\n').map(|i| i + 1).unwrap_or(script.len());
	let first_line = &script[..after_first_line];
	let rest = &script[after_first_line..];

	// Patch the tag completer in the (run) block.
	let run_marker = "\n(run)\n";
	let patched_rest = if let Some(run_start) = rest.find(run_marker) {
		let block_body_start = run_start + run_marker.len();
		let block_body = &rest[block_body_start..];
		let block_len = block_body.find("\n(").unwrap_or(block_body.len());
		let run_block = &block_body[..block_len];

		let tag_prefix = "'::tag -- ";
		let tag_suffix = ":_default' \\";
		if let (Some(tag_pos), Some(suffix_rel)) = (
			run_block.find(tag_prefix),
			run_block
				.find(tag_prefix)
				.and_then(|p| run_block[p..].find(tag_suffix)),
		) {
			let abs = block_body_start + tag_pos + suffix_rel;
			format!(
				"{}{}{}",
				&rest[..abs],
				":_octomind_complete_run' \\",
				&rest[abs + tag_suffix.len()..]
			)
		} else {
			rest.to_string()
		}
	} else {
		rest.to_string()
	};

	format!("{first_line}{helper}\n{patched_rest}")
}

/// Fish: append a dynamic completion line for `octomind run`'s TAG positional.
fn patch_fish(script: &str) -> String {
	// Fish doesn't have a positional-arg slot in the generated output for TAG,
	// so we append a line that calls `octomind complete run` as the candidates.
	let dynamic_line = concat!(
		"\n# Dynamic TAG completions for `octomind run`\n",
		"complete -c octomind -n '__fish_octomind_using_subcommand run' ",