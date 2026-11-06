# Brief: <owner/repo>#<issue>, <title>

<!-- Write one direct order from the sender, using every field below. Do not quote the owner or attach messages
from above the sender. A seat knows only its Lead: name no chain above it. Keep dated decisions and their sources
on the issue or decision item; read that record yourself when exact words matter, then brief from these fields.
Send the brief again, with the open findings, on every review round. Delete this comment. -->

## What to build

The outcome, acceptance, scope and what is not asked of the session. Say exactly what to report back, including
evidence and anything the receiver could not settle.

## Why

The goal this work serves and the problem it solves.

## Constraints checked

The constraints verified against the sources, with file:line where useful. Name the work folder, inputs, files the
receiver may change, and commands it may and may not run. Name each test command whole, run on its own after a
separate `cd`, with no `env` prefix, pipe or `;`: in this factory, `scripts/verify`, whose sandbox keeps the tests off
the host's own state (never plain `node --test` here). Or say that the session runs none. Never write "check it against"
a script, which leaves the session to build a command that a deny rule refuses (#256). Include these instructions:

Write and change file content with the Edit and Write tools, never through Bash (a heredoc, `cat >`, `tee`, `printf >`
or `echo >`). That is not a general permission: when an action is refused (a push, a read, a deny rule, a command that
requires approval), stop and report its exact message to your Lead, and never retry it in another form, with another
tool or a script. Do not push; report the result to your Lead.

## Assumptions still open

What has not been verified, what the receiver should investigate, and what it must return to the sender to settle.
Do not turn an assumption into a constraint.

## What was decided

The decisions that apply to this work, stated directly without quoting their authors.

## What the receiver may challenge

Which decisions remain open to challenge, what evidence would justify a change, and what must go back to the sender.
