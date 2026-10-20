// Which backend `bash` runs a command on when the model names none (docs/spec.md → Backends): the Worker Shell unless
// the command needs something it does not have. The table is the heuristic's contract, one row per decision.
// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import { routeCommand } from "./bash-routing.ts";
import type { BashBackend } from "./coding-tools.ts";

type Row = readonly [command: string, because: string];

const worker: readonly Row[] = [
  // The acceptance examples.
  ["cat README.md", "a built-in command"],
  ["grep -rn TODO src", "grep"],
  ["sed -i 's/a/b/' src/a.ts", "sed"],
  ["jq .name package.json", "jq"],
  ["git status", "git status"],

  // Text and file commands, pipelines, lists.
  ["", "nothing to run"],
  ["   \n", "nothing to run"],
  ["ls -la && pwd", "&& between built-ins"],
  ["cat a.txt | sort | uniq -c | sort -rn | head", "a pipeline of built-ins"],
  ["grep -E 'foo|bar' a.txt", "| inside quotes is not a pipe"],
  ["echo 'a && node b'", "a command named inside quotes is text"],
  ['echo "run npm test; then node x"', "a command named inside double quotes is text"],
  ["echo hi # then npm test", "a comment"],
  ["cat a.txt # node", "a trailing comment"],
  ["cd src && cat a.ts", "cd is a shell built-in"],
  ["cat a.txt || echo missing", "|| between built-ins"],
  ["echo hi > out.txt 2>&1", "redirects"],
  ["sort < in.txt > out.txt", "redirects from a file"],
  ["cat missing 2>/dev/null; true", "redirect to /dev/null"],
  ["echo done &", "a built-in in the background"],
  ["printf '%s\\n' b a | sort -u", "printf, sort"],
  ["find . -name '*.ts' | xargs grep -l needle", "xargs runs a built-in"],
  ["find . -name '*.ts' -exec cat {} \\;", "find -exec runs a built-in"],
  ["find . -name '*.log' -delete", "find"],
  ["tar czf out.tgz src && gzip -l out.tgz", "tar and gzip"],
  ["awk '{print $1}' a.txt", "awk, and $1 is awk's"],
  ["wc -l *.ts", "globs"],
  ["diff a.txt b.txt", "diff"],
  ["rg needle src", "rg"],
  ["which cat", "which asks for a built-in"],
  ["command -v grep", "command -v asks for a built-in"],
  ["type cat", "type asks for a built-in"],
  ["tree -L 2", "tree"],
  ["date +%s", "date"],

  // Variables, assignments, substitutions, shell syntax.
  ["FOO=1", "an assignment"],
  ["FOO=1 BAR=2 cat a.txt", "assignments before a built-in"],
  ["export FOO=1 && echo $FOO", "export"],
  ["x=$(date); echo $x", "a substitution of a built-in"],
  ["echo $(cat version.txt)", "a substitution of a built-in"],
  ["echo `cat version.txt`", "a backtick substitution of a built-in"],
  ['echo "v: $(cat version.txt)"', "a substitution inside double quotes"],
  ["echo $((1 + 2))", "arithmetic is not a command"],
  ["echo ${HOME:-/root}", "parameter expansion"],
  ["(cd src; ls)", "a subshell of built-ins"],
  ["{ echo a; echo b; } > out.txt", "a group of built-ins"],
  ["for f in *.ts; do echo $f; done", "a loop of built-ins"],
  ["for f in node npm; do echo $f; done", "words after in are not commands"],
  ["while read line; do echo $line; done < list.txt", "a while loop"],
  ["if [ -f a.txt ]; then cat a.txt; else echo none; fi", "an if of built-ins"],
  ["if ! grep -q x a.txt; then echo no; fi", "! negation"],
  ["[[ -f a && -f b ]] && cat a", "&& inside [[ ]] is not a list"],
  ["test -d src && ls src", "test"],
  ["f() { cat a.txt; }; f", "a function defined in the command"],
  ["function g { cat a.txt; }; g", "a function defined with the keyword"],
  ["cat <<'EOF' > notes.md\nnode is a runtime\nnpm test\nEOF", "a quoted heredoc body is text"],
  ["cat <<EOF\nhello\nEOF\necho after", "a heredoc, then a built-in"],
  ["cat <<-EOF\n\tnpm test\n\tEOF", "an indented heredoc"],
  ["cat <<< 'node x'", "a here-string is data"],
  ["cat a.txt \\\n  | wc -l", "a line continuation"],
  ["echo hi\ncat a.txt", "newline lists"],

  // Wrappers around a built-in.
  ["env FOO=1 grep x a.txt", "env runs a built-in"],
  ["env -i FOO=1 printenv FOO", "env options"],
  ["env", "env alone prints"],
  ["timeout 5 cat a.txt", "timeout runs a built-in"],
  ["time ls", "time runs a built-in"],
  ["command cat a.txt", "command runs a built-in"],
  ["bash -c 'cat a.txt | wc -l'", "bash -c of built-ins"],
  ['sh -c "echo hi"', "sh -c of a built-in"],
  ["xargs", "xargs alone is echo"],
  ["ls | xargs -n 1 -I {} echo {}", "xargs options with a built-in"],

  // git: the read-only forms whose output matches real git's (checked in bash.workerd.test.ts).
  ["git status", "bare git status"],
  ["git status | head", "git in a pipeline"],
  ["git -C repo status", "-C <dir>"],
  ["git log --oneline", "git log --oneline"],
  ["git log --oneline -n 5", "--oneline -n"],
  ["git log --oneline -5", "-<count>"],
  ["git rev-parse HEAD", "rev-parse HEAD"],
  ["git rev-parse --show-toplevel", "--show-toplevel"],
  ["git rev-parse --abbrev-ref HEAD", "--abbrev-ref"],
  ["git branch", "list branches"],
  ["git branch --show-current", "--show-current"],
  ["git ls-files", "git ls-files"],
];

const container: readonly Row[] = [
  // The acceptance examples.
  ["node script.js", "node"],
  ["npm install", "npm"],
  ["gh pr list", "gh"],

  // Runtimes, package managers, toolchains.
  ["node -v", "node"],
  ["npx vitest run", "npx"],
  ["pnpm test", "pnpm"],
  ["yarn build", "yarn"],
  ["bun run x", "bun"],
  ["python3 x.py", "python3"],
  ["python -c 'print(1)'", "python"],
  ["pip install requests", "pip"],
  ["mise install", "mise"],
  ["mise exec -- node x.js", "mise"],
  ["cargo build", "cargo"],
  ["go test ./...", "go"],
  ["make", "make"],
  ["tsc --noEmit", "tsc"],
  ["curl -s https://example.com", "the Worker Shell has no network"],
  ["wget https://example.com/x", "wget"],
  ["yq .a config.yaml", "yq is not in the Worker Shell"],
  ["sqlite3 db.sqlite .tables", "sqlite3 is not in the Worker Shell"],
  ["mktemp", "mktemp is not in the Worker Shell"],
  ["ps aux", "ps"],
  ["unknown-tool --flag", "anything unknown"],

  // Paths and the shell's own dynamic parts.
  ["./script.sh", "a relative path"],
  ["./node_modules/.bin/vitest", "a binary by path"],
  ["/usr/bin/node x.js", "an absolute path"],
  ["scripts/build.sh", "a path with a directory"],
  ["bash script.sh", "bash running a file"],
  ["sh ./script.sh", "sh running a file"],
  ["cat a.sh | bash", "bash reading a script from stdin"],
  ["source env.sh", "source runs a file"],
  [". env.sh", "dot runs a file"],
  ['eval "$cmd"', "eval of an unknown string"],
  ["$CMD --version", "a command named by a variable"],
  ['"$TOOL" run', "a quoted variable as the command"],
  ["case $x in a) cat f;; esac", "case is left to bash"],

  // One command that needs it sends the whole call.
  ["cat package.json | node -e 'process.stdin.pipe(process.stdout)'", "the end of a pipeline"],
  ["node gen.js | grep x", "the start of a pipeline"],
  ["cat a.txt && npm test", "the end of a list"],
  ["npm test || cat log.txt", "the start of a list"],
  ["echo building; node build.js", "after a ;"],
  ["echo hi\nnpm test", "on a later line"],
  ["(cd app && npm install)", "inside a subshell"],
  ["{ npm test; }", "inside a group"],
  ["echo $(node -v)", "inside a substitution"],
  ["echo `node -v`", "inside a backtick substitution"],
  ['echo "v: $(node -v)"', "inside a substitution in double quotes"],
  ["x=$(node -v); echo $x", "inside an assignment's substitution"],
  ["V=$(npm pkg get version) cat a", "inside a prefix assignment's substitution"],
  ["if true; then node x.js; fi", "inside an if"],
  ["for f in a b; do node $f; done", "inside a loop"],
  ["while read l; do npm i $l; done < list.txt", "inside a while"],
  ["f() { node x; }; f", "inside a function body"],
  ["cat <<EOF | node\nconsole.log(1)\nEOF", "after a heredoc's pipe"],
  ["cat <<EOF\n$(node -v)\nEOF", "a substitution in an unquoted heredoc body"],
  ["[[ -f a ]] && node a", "after [[ ]]"],
  ["diff <(node a.js) b.txt", "process substitution is left to bash"],
  ["echo 'unterminated", "a command that does not parse"],
  ["echo $(node -v", "an unclosed substitution"],

  // Wrappers around a real binary.
  ["FOO=1 node x.js", "a prefix assignment before node"],
  ["env FOO=1 node x.js", "env runs node"],
  ["env -i PATH=/bin node x.js", "env options before node"],
  ["sudo cat /etc/passwd", "sudo is not a built-in"],
  ["sudo apt-get install x", "sudo"],
  ["nohup node server.js &", "nohup"],
  ["nice -n 5 cat a", "nice is not a built-in"],
  ["time npm test", "time runs npm"],
  ["timeout 10 npm test", "timeout runs npm"],
  ["timeout -s KILL 10 node x.js", "timeout options before node"],
  ["command node -v", "command runs node"],
  ["exec node x.js", "exec runs node"],
  ["bash -c 'node x.js'", "bash -c runs node"],
  ['sh -c "cat a | node"', "sh -c runs node"],
  ["bash -lc 'npm test'", "a cluster with c"],
  ["xargs -n 1 node", "xargs runs node"],
  ["ls *.js | xargs -I {} node {}", "xargs -I runs node"],
  ["find . -name '*.js' -exec node {} \\;", "find -exec runs node"],
  ["find . -name '*.js' -exec node {} +", "find -exec ... + runs node"],
  ["which node", "which asks about a binary"],
  ["command -v npm", "command -v asks about a binary"],
  ["type gh", "type asks about a binary"],
  ["which cat node", "one of the names is a binary"],

  // git: what writes the index or refs, what the Worker Shell's git gets wrong, the network, the working tree.
  ["git add .", "add writes the index"],
  ["git add -A && git commit -m x", "commit writes refs"],
  ["git commit -m 'fix: x'", "commit"],
  ["git rm --cached a.txt", "rm writes the index"],
  ["git tag v1", "tag writes refs"],
  ["git tag", "tag lists, but it is not a read-only set"],
  ["git branch feature", "branch <name> writes refs"],
  ["git branch -d feature", "branch -d writes refs"],
  ["git branch -a", "an option the client does not know"],
  ["git init", "init writes .git"],
  ["git remote add origin x", "remote add writes config"],
  ["git remote -v", "remote"],
  ["git diff", "diff differs from git's"],
  ["git diff --stat", "diff"],
  ["git diff main...HEAD", "diff of a revision prints nothing there"],
  ["git diff origin/main..HEAD --stat", "diff of a revision"],
  ["git show HEAD", "show has no patch there"],
  ["git show HEAD:a.txt", "show of a path at a revision"],
  ["git log", "log's dates are not git's"],
  ["git log --oneline -- src/a.ts", "log of a path"],
  ["git log --oneline main", "log of a revision"],
  ["git log --format=%H", "log with a format"],
  ["git status -s", "status -s prints untracked as ' ?'"],
  ["git status --porcelain", "status --porcelain is not git's"],
  ["git status src", "status of a path"],
  ["git rev-parse main", "rev-parse of a name"],
  ["git rev-parse HEAD~1", "rev-parse of an expression"],
  ["git ls-files src", "ls-files of a path"],
  ["git ls-tree HEAD", "ls-tree"],
  ["git cat-file -p HEAD", "cat-file"],
  ["git symbolic-ref HEAD", "symbolic-ref"],
  ["git config user.name", "config reads the Container's identity"],
  ["git clone https://github.com/a/b", "clone needs the network"],
  ["git push", "push needs the credentials"],
  ["git push origin main", "push"],
  ["git pull", "pull needs the network"],
  ["git fetch --all", "fetch needs the network"],
  ["git checkout -b feature", "checkout rewrites the tree"],
  ["git switch main", "switch rewrites the tree"],
  ["git reset --hard HEAD~1", "reset rewrites the tree"],
  ["git merge main", "merge"],
  ["git stash", "stash"],
  ["git clean -fd", "clean"],
  ["git rebase main", "rebase is not in the client"],
  ["git cherry-pick abc", "cherry-pick is not in the client"],
  ["git blame a.ts", "blame is not in the client"],
  ["git --no-pager log --oneline", "a global option the client does not know"],
  ["git -c user.name=x status", "a global option the client does not know"],
  ["git -C a -C b status", "two -C"],
  ["git", "git alone"],
  ["git status && git push", "push later in the list"],
  ["git status; npm test", "npm after git"],
  ["git $SUB", "a subcommand from a variable"],
  ["GIT_TERMINAL_PROMPT=0 git push", "a prefix assignment before git push"],
  ['echo "${VERSION:-$(node -p 1)}"', "a substitution inside ${…}"],
  ["echo $(( $(node count.js) + 1 ))", "a substitution inside $((…))"],
  ["echo ${x:-`node -v`}", "a backtick substitution inside ${…}"],
];

describe("routeCommand", () => {
  it.each(worker)("runs `%s` on the Worker Shell (%s)", (command) => {
    const route = routeCommand(command);

    expect(route.backend).toBe<BashBackend>("worker");
  });

  it.each(container)("runs `%s` in the Container (%s)", (command) => {
    const route = routeCommand(command);

    expect(route.backend).toBe<BashBackend>("container");
  });

  it("names the command that needs the Container", () => {
    expect(routeCommand("cat a.txt && npm test").reason).toMatch(/npm/);
    expect(routeCommand("git push origin main").reason).toMatch(/git push/);
    expect(routeCommand("./run.sh").reason).toMatch(/\.\/run\.sh/);
  });

  it("gives a reason for staying on the Worker Shell", () => {
    expect(routeCommand("grep -rn TODO src").reason).not.toBe("");
  });

  it("does not depend on how long the command is", () => {
    const long = `${Array.from({ length: 500 }, () => "echo hi").join("\n")}\nnode x`;

    expect(routeCommand(long).backend).toBe("container");
    expect(routeCommand(long.replace("node x", "cat x")).backend).toBe("worker");
  });
});
