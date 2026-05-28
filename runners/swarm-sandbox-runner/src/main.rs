use clap::{Parser, Subcommand};
use std::io::Read;
use swarm_sandbox_runner::error::RunnerError;
use swarm_sandbox_runner::events;
use swarm_sandbox_runner::mode;
use swarm_sandbox_runner::policy::Policy;
use swarm_sandbox_runner::probe;

#[derive(Parser)]
#[command(name = "swarm-sandbox-runner", version, about = "Windows sandbox runner for opencode-swarm")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Report capability matrix as JSON on stdout
    #[arg(long)]
    probe: bool,

    /// Read JSON policy from stdin
    #[arg(long)]
    policy_stdin: bool,

    /// Sandbox mode: auto, app-container, restricted-token
    #[arg(long, default_value = "auto")]
    mode: String,

    /// Command and arguments to execute (after --)
    #[arg(last = true)]
    cmd: Vec<String>,
}

#[derive(Subcommand)]
enum Commands {}

fn main() {
    let cli = Cli::parse();

    if cli.probe {
        run_probe();
        return;
    }

    if cli.policy_stdin {
        if let Err(e) = run_sandboxed(&cli) {
            let code = e.exit_code();
            eprintln!("{e}");
            std::process::exit(code);
        }
        return;
    }

    if !cli.cmd.is_empty() {
        eprintln!("error: --policy-stdin is required when executing a command");
        std::process::exit(67);
    }

    eprintln!("usage: swarm-sandbox-runner --probe");
    eprintln!("       swarm-sandbox-runner --policy-stdin --mode <mode> -- <cmd> [args...]");
    std::process::exit(67);
}

fn run_probe() {
    let result = probe::run_probe();
    match serde_json::to_string_pretty(&result) {
        Ok(json) => {
            println!("{json}");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("probe serialization error: {e}");
            std::process::exit(69);
        }
    }
}

fn run_sandboxed(cli: &Cli) -> Result<(), RunnerError> {
    if cli.cmd.is_empty() {
        return Err(RunnerError::LauncherMisconfig(
            "no command specified after --".into(),
        ));
    }

    // Read policy from stdin
    let mut stdin_buf = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin_buf)
        .map_err(|e| RunnerError::PolicyParse(format!("failed to read stdin: {e}")))?;

    let policy: Policy = serde_json::from_str(&stdin_buf)
        .map_err(|e| RunnerError::PolicyParse(format!("invalid policy JSON: {e}")))?;

    policy.validate()?;

    // Select sandbox mode
    let sandbox_mode = mode::select_mode(&cli.mode, &policy)?;

    // Execute in sandbox
    let result = mode::execute(sandbox_mode, &policy, &cli.cmd)?;

    if result.exit_code != 0 {
        std::process::exit(1);
    }

    Ok(())
}
