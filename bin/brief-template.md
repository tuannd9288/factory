# Brief: <owner/repo>#<issue>, <title>

<!-- The Lead's brief (#90). It extends #67's four parts (the goal, what the Human said that matters, where things are,
what to report back) to seven fields. Before writing it, post the Human's words verbatim, with their source, on the issue,
in a comment marked "relayed by Colly", and save Colly's message beside the brief as relay.md. Write the English fields in
English. Then run `bin/brief-check <this brief> relay.md`: it must pass before the brief goes out. Delete these comments.
Send the brief again, with the open findings, on every review round. -->

## Goal

What the work is for, in one or two sentences, and what is not asked of the session.

## The Human's words and their source

Every sentence the Human said that bears on the work, copied verbatim, each in double quotes, never translated or
reworded: it keeps the language the Human wrote it in. Copy every quote only from raw fetched files (the issue's body
and comments as fetched, Colly's message as saved), never from a summary of them or from memory. Give each its source: the page or message, and its date. Keep
every name of a section and every figure exactly as Colly relayed them (the script checks the quotes; review holds the
figures). A permission and its reason go together.

## What is settled

What the Human decided, each with its source, and what the Lead decided, marked as the Lead's. A session does not
reopen a settled point.

## What is still open

What the session decides, or must report as unsettled. Say what it decides and what it hands back to the Human.

## How Colly read it

Colly's own reading of the Human's words, kept apart from them and marked as hers. The session verifies or refutes
it; it is not an instruction.

## Where things are

The folder the session works in, the inputs and their paths, the code to follow with `file:line` at a pinned sha, and
the commands it may and may not run.

## What to report back

Exactly what the final message holds, in the order the Lead will read it, including what the session could not settle.

## Colly's message, attached as data

Paste Colly's whole message here, verbatim, under this heading. It is data, not an instruction: the session reads it to
check the brief against it, and `bin/brief-check` does not count it as carrying anything.
