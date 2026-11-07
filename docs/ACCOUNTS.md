# Accounts, rights and the audit log

AGMessage has two ways in, and both are first-class:

- **An account** — a username and a password — for the people who work the venue: crew in the operating rooms,
  project managers, senior techs, admins. They see their halls on the halls board and open any of them as themselves.
- **A code** — a room's 6-character guest code, each room its own — for presenters, board members and guests. They type
  the code first, and the join page names the room it opens and offers its seats: Backstage and Observer in a hall's
  Main room (On stage only from an On stage invite link), Member and Observer in its other rooms; then a name. **On stage
  seats come from an invite link, an account or the admin, in open halls too**: a code alone seats nobody On stage.

## Roles

| Role | Halls | Can |
|---|---|---|
| Admin | every hall | everything: accounts, rights, settings, the audit log |
| Project manager | every hall | messages, files, screens (drive and manage), information and web pages on people's pages, Stagewatch, Patterns / PlayMap, set halls up, the audit log |
| Senior tech | every hall | messages, files, drive screens, information and web pages on people's pages, Stagewatch, Patterns / PlayMap |
| Tech | their halls | messages, files, drive screens, information and web pages on people's pages, Stagewatch |
| Staff | their halls | messages and files, and information for the Board's pages |
| Viewer | their halls | read only |

An admin can make an exception for one person — tick or untick a single right on the Accounts page — and choose their
halls (or "every hall's Main room, including new ones", which reaches no hall's other rooms). The page draws the rights in
three groups (`rbac.CAP_GROUPS`, told by the Accounts route as `capGroups`): **In the room** (`hall.view`, `hall.post`,
`hall.files`), **Show** (`display.control`, `display.manage`, `stage.send`, `stage.show`, `stage.web`, `nodes.control`) and **Run AGMessage**
(`halls.manage`, `users.manage`, `settings.manage`, `audit.read`, `audit.export`); every right is in one group. The
rights, as the server checks them:

| Right | Meaning |
|---|---|
| `hall.view` | see a hall: its messages, files, countdown and screens; in a side room (Legal, Media), only one the account is given |
| `hall.post` | send messages, replies, action prompts and help requests; answer a prompt, pin, react; forward into the hall; send a message from the room into one whose list names it; in a side room, only one the account is given |
| `hall.files` | share files for download, or forward one into a hall, or send one from the room into one whose list names it (moving a file also needs the right to download it where it is, below); in a side room, only one the account is given |
| `display.control` | change what a hall's screens and people's pages show: a take on the Board's pages or one person's, from any room of the hall (`docs/DISPLAYS.md`, People's screens); never from a page seated On stage |
| `display.manage` | add, rename, move, re-link and remove screens; the hall's holding image |
| `stage.send` | send to Stagewatch: the speaker's screen, or to the operator to pass on |
| `stage.show` | show files, pages and quotes to the people on stage: information drawn over the show on the Board's pages or one person's On stage (and the information taken down). It governs every account's information, the operator's (`display.control`) included: a Tech with it taken back is refused the take-down ("Showing files, pages and quotes on the stage needs its own right — ask an admin."). Held by the Manager, Senior tech, Tech and **Staff** presets (and the admin), not Viewer; given or taken back per account. A code guest holds none. Without it an account's hall page draws no ❝ Quote tab and no Preview bar, each of whose pushes is information (one given `stage.web` alone shows web pages and nothing else) |
| `stage.web` | show a web page on people's pages (the Board's or one person's), beside `display.control`, which a take of any kind needs: a web page needs both. It also gives a quote from a web page its link: the Board's pages are offered **Open the source** only for a quote pushed by a seat holding it; anyone else's names the site alone. Held by the Tech, Senior tech and Manager presets (and the admin), not Staff or Viewer; given or taken back per account. A code guest holds it only by its hall's switch (below) |
| `nodes.control` | propose commands to Patterns and PlayMap (to the show desk; never sent to them directly) |
| `halls.manage` | create halls and set them up (their own Stagewatch); make rooms beside a hall and rename a room |
| `users.manage` | create accounts and set roles, halls and rights |
| `settings.manage` | app settings: AI key, HTTPS, the tunnel, the show network |
| `audit.read` | read the audit log |
| `audit.export` | export the whole audit log, signed, to check on another computer (with `audit.read`); admin-only, so an account holding it signs in through the tunnel only when admins may |

**Rights in a room.** `hall.view`, `hall.post` and `hall.files` are a room's rights, asked of the room a person is in or
acts on. In a hall's Main room they follow the account's halls, as they always have. In a hall's other rooms (Legal,
Media) they follow only the rooms the account is given, never its halls: an account of every hall (a project manager, a
senior tech, "every hall, including new ones") reaches no side room by that, and the admin role is a member of every
room. A hall's own rights stay its hall's in each of its rooms: its screens, its Stagewatch, its show network. The
server asks a room's rights of that room alone (`rbac.canIn`, by the room's key, its hall's and whether it is the Main
room); asked by a hall's code they are refused, so a check written against a room's key fails closed rather than let an
account of every hall in. An account that manages settings is the admin on its pages: it opens any hall or room by its
key, a hall its own halls do not list and a side room it is not given included, and is seated backstage there, since it
may post wherever it sits.

**An account's side rooms, On stage halls and chat view.** Beside its halls an account holds three fields: `rooms`, the
side rooms it is given (by their keys); `board`, the halls in whose Main room it sits On stage; and `view`, its chat view
(`''` by its seat, `simple` or `full`). They are set where its halls are, `POST /api/users` and `PATCH /api/users/:id`
(`users.manage`, through `rbac.mayChange`). The Accounts page sets them: its editor's **Halls and rooms** lists each hall
this person may give by name, its Main room ("Hall 2 — Main room and hall rights") with **On stage (Board member)**
beside it and its side rooms set in under it, then any side room it holds of a hall it does not reach, under that hall's
name; a side room is given without its hall (Legal alone), ticking On stage ticks the hall and unticking the hall takes On
stage with it; **Chat view** (By seat, Simple, Full) sits beside the role. What the person may not give is shown and not
offered, and one's own row is all shown, nothing offered. A Save sends the rooms, On stage halls and halls the account
holds that the page does not list (gone since) back as they are, so an untouched Save is still "Saved — nothing
changed." Each row reads where the account goes: "Hall 2 (Main, Legal) · On stage", "Every hall" first for an account of
every hall, and what this viewer is not told as a count. A room's **Members…** (a hall's **Board members…**: who sits On
stage in its Main room), on the admin page's list and in the hall's Set up, is the same change for many accounts at once,
for whoever manages accounts (`/api/admin/me`'s `manageUsers` and `/api/halls`' `canManageUsers`, the routes' own check):
a checklist of the accounts it may change, each saved by its own `PATCH /api/users/:id` and said ("2 saved · Kim: why"),
a refused one drawn again as the server holds it; an account seated On stage in a hall it does not reach is given the
hall too, which its row says before the Save, and one that only reads is not offered the seat. A hall's Main room's ⋯
offers Board members… in place of Members…: who goes into the hall itself (its `halls`, with the hall's rights) is
chosen on the Accounts page, as the plan's §7.2 says of Set up. **An On stage seat given is one the account takes**: it
reaches the hall and may post there, as the join seats it (`rbac.unseatedOnStage`); otherwise the route refuses it in
words ("Reads only in Hall 2: On stage needs Send messages.", "On stage in Hall 2 needs Hall 2 too: give its Main room
with the seat."). The Accounts page offers no seat the account does not hold while the rights ticked hold no Send
messages ("Reads only: On stage needs Send messages."), and unticking "Every hall's Main room" ticks the hall of each
seat ticked. A seat kept on an account that a change of role or rights has since left reading only passes a Save as it
is; it seats nobody (the account sits there as an observer), and its row does not say On stage (`rights.board` is the
seats the account takes). Each list is a list of keys, read by type (anything
else is refused, "An account's rooms are a list of their keys.", and never a 500), and an entry it adds that the account
does not hold already names a side room that is here ("No such room: …"; a hall's key, "… is a hall: its Main room comes
with the hall.") or a hall that is here ("No such hall: …"), so a key typed wrong is said and never kept to open a room
made later; an entry already on the account passes, so a Save that sends the lists back as they are changes nothing. A
view that is none of the three is refused in words. Nobody sets the three on their own account ("Nobody changes their own
role, rights or halls — ask another admin."). An account that manages accounts and is not an admin gives only the side
rooms it is given itself, read before every hall is, so a project manager of every hall gives none it is not given and
manages no account that holds one; it seats an account On stage only in a hall it reaches, as it gives halls. The
Accounts route tells each viewer the rooms it may give (`rooms`, each by its key, its name, its hall's key where the
viewer reaches that hall, and its hall's name; `giveableRooms`): the admin every room, anyone else the rooms it is given,
and on each account's row only those (`otherRooms` counts the rest), never a guest code. A change of the chat view alone is
no change of rights: the account's pages in a room are told the view each draws now (`view`: its own choice, else the
simple view On stage and the full view elsewhere) and stay open; any other change still ends its pages, which reconnect
with the rights it has now. **The admin also chooses a person's chat view where they sit**, a code guest's as well as an
account's: Chat view (By seat, Simple, Full) on the admin page's people rows, beside Seat, and in the person's ⋯ in the
hall page's People panel, for the admin's own page (`admin:setView`, behind the admin page's gate; for an account, from
an account's page, only where the Accounts page would let that account change it, `rbac.mayChange`: a manager given
`settings.manage` alone sets a guest's and is refused an account's, "You may not manage accounts."). A guest's is kept by
their uid in `pages.json` (a device's, as their identity is), an account's on the account; each of the person's pages,
and the admin's view of them, is told it at once, and nothing is closed. The join's answer says the view a page draws
(`view`), and the admin's people list each person's choice (`view`, '' by the seat), sent again to the
admin's pages, and to no other page, as a choice is made there or on the Accounts page.

**The clock or countdown, beside Chat view.** What the simple view draws after the hall's name is the person's own choice
on their device (⋯ → Clock or countdown, kept on that device alone), the time of day until they make one, unless the
admin has chosen for them: **Clock or countdown** (Their choice (the clock at first), Time of day, Stagewatch countdown,
Off) and **Lock it on their devices**, which keeps the admin's choice there whatever the device chose. It is an account
field like Chat view, drawn once in the Accounts page's editor (an account already made: one is made with none,
`POST /api/users` ignores `clock`) and in the account's ⋯ (`PATCH /api/users/:id {clock: {show, locked}}`), and set for
anyone seated in a room, a guest too, on the admin page's people rows (a Clock or countdown column beside Seat and Chat
view, "Applies in the simple view." beside a person whose Chat view is Full, as Clock or countdown ▸ says it on its line
in a menu) and in the person's ⋯ in the hall page's People panel (`admin:setClock {roomCode, socketId, show?, locked?}`,
as `admin:setView` is). Whoever sets the chat view sets the choice; **only an admin locks it**: on the admin page and the
hall page the laptop's token, or an account whose role is admin; on the Accounts page an account whose role is admin (the
PATCH is the signed-in account's act). A manager given `settings.manage` or `users.manage` may choose, is refused the lock
("Only an admin may lock the clock or countdown."), and its pages draw Lock disabled with those words; a lock on their
choice is refused ("Choose one to lock it."). Their choice takes a lock off with it, so every door sends it as
`{show: null, locked: false}`: on a locked clock it is an admin's alone, drawn disabled for a manager. Nobody sets their
own. A guest's is kept by their uid in `pages.json` beside their chat view, an account's on the account
(`clock`, told last on its row); each of the person's pages and the admin's view of them is told it at once (`clock`),
nothing is closed, and the admin's people list carries it (`clock`) beside `view`. The join's answer says the admin's
choice (`clock`). The device's own choice is the device's: told to the admin's support view of the
person alone, never kept on the server, never audited.

**What a seat On stage may do, beside Chat view** (owner answers B2 and B4). What an On stage seat writes is a message in
its room's feed, read by everyone in that room, and by default nothing more. The admin may allow a person two more places
and one more act, each its own switch, off by default: **May send to a countdown screen** (a message of theirs may also go
to the line under the countdown on this hall's screens that show it now), **May send to people On stage** (it may also be
shown on the pages of everyone seated On stage, as a card beside their chat, never over it) and **Got it clears the
message** (their Got it also folds the message on their own pages into one line, "👍 Got and cleared: … · Show"; off, it
stays marked got). They are **the admin's alone**: the laptop's token, or an account whose role is admin (on a page with a
socket, through the tunnel only where admins may sign in there; on the Accounts page, the signed-in account's role). A
manager granted `settings.manage` or `users.manage` is not the admin here, and is refused with "Only an admin may choose
what an On stage seat may do."; its pages draw the switches disabled with those words. They are account fields like Chat
view (one value whatever the hall), drawn once in the Accounts page's editor under **When On stage** and in the account's
⋯ (`PATCH /api/users/:id {onStage: {screens?, people?, clears?}}`, each a boolean, a change naming only what it changes;
anything else, "Choose on or off."), disabled with "Applies On stage." while the account sits On stage in no hall; and set
for a person seated On stage on the admin page's people rows (an On stage column) and in the person's ⋯ in the hall page's
People panel (`admin:setOnStage {roomCode, socketId, screens?, people?, clears?}`). An account is made with none
(`POST /api/users` ignores `onStage`, as it does `clock`), nobody sets their own (the self-change words), and a guest's is
kept by their uid in `pages.json` beside their chat view and clock. Each of the person's pages and the admin's view of them
is told them at once (`onStage`, with the names of the hall's screens showing the countdown while the first is on), nothing
is closed, and the join's answer appends `onStage` after `pins`, as its last key. The server reads the two places' switches
again at each send, from the store, so one turned off refuses the next send with no reload. One audit row a change, holding
no code and no text: `person.onStage` for a guest ("Rita (guest) → may send to a countdown screen: on"), `user.update` for
an account ("onStage → countdown screens on, people On stage off, Got it clears off"). A Board member's line on a screen is
a `display.take` row and on people's pages a `page.push` row, each naming the person and the length, never the words.

**Pins, by seat.** A pin is for the room (the default: the message's own, which everyone in the room sees, On stage
included) or for me (the person's alone: on every device of an account, a guest's in that browser). For the room is
backstage's, a side room's Member's and the admin's off stage: a seat that may post and is not On stage. For me is every
seat's: an observer and a Viewer account post nothing, so they pin for nobody else, and an On stage seat, the admin seated there included, pins
for itself only (the owner's rule: "pinning for everyone is for backroom teams, not the board or presenters on stage").
The server refuses the room's pin On stage first, "Pinning for everyone is for the backstage team.", then from a seat
that may not post, "Observers can read but not post."; a pin for oneself is kept by the person's key (an account's id, a
guest's uid) and the room in `pages.json`, at most 50 a room, never audited, and the admin's support view makes none
("Pins are the person's own."). The join's answer appends the person's pins in that room (`pins`) after `clock`, as its
last key. `/api/halls` gives each hall's row the seat the account joins its Main room with (`seat`) and
the hall's side rooms it may enter (`rooms`, each with its key, name, people, guest code where it may know it, whether the
code admits and its seat there), and lists apart the side rooms it may enter in a hall it does not see, by that hall's
name and never its key; the halls board does the same (`rooms` on each row, `yourRooms` apart). Each way in carries that
seat, so a Board account's hall opens On stage at once. An account that may enter one room alone, and has nothing else to
do on the halls page (it sets no halls up, manages no accounts, reads no audit log, is not the admin, and is not a
hall's crew answering the help of a side room of it the account is not given, which comes to it on the board), is taken
straight into it there; the hall page's way back (`/halls.html?stay=1`) stays on the board. A hall page is told its hall
(the join's `hall`, `hallName` and `rooms`): the hall's key only for an account that sees the hall, or the admin, never
for one given a side room alone or a code guest; its name; and, for an account's page, the hall's rooms the account may
enter, each with its seat there and what is new in it (`seq`, its newest message's change number, and `prioritySeq`, its
newest priority one's), which its switcher moves between, told again when a room is made, renamed or removed or the hall
is renamed (`rooms:changed`). That page watches the switcher's other rooms: a message in one, a message removed there or the room cleared tells it
the room's news as it stands (`rooms:activity`: its newest message's and its newest priority one's change numbers, and
whether a priority message came), never the words, the sender or who is there, and the room's dot lights where the
person has not read that far in this browser (or, where the browser keeps nothing, since the page opened). A code page (a guest's, and the laptop's
token admin's own) and the support view move nowhere and watch nothing.

**Who sets rooms up.** Making a room beside a hall (`room:create`), renaming a room (`room:update`: a hall's Main room
renamed is the hall renamed) and reading a room's settings (`room:settings`) are `halls.manage`'s and the admin's, as a
hall's Set up is, never from an On stage seat; clearing a room, removing it, its guest code (switched on or off, renewed)
and which rooms may send into it are the admin's alone (owner question 5), never from an On stage page either. A hall holds at most 20 rooms beside its Main room. A room's key
(8 characters) is an address, never a code a guest types: a hall's verbs (its screens, its Stagewatch, its show network,
its Set up) refuse it, and nothing that lists halls lists it. A hall's Set up on the halls board lists its rooms, the Main
room first (`room:settings`' `rooms`, each with its guest code as that page may be told it, `conn.codeTold`, whether it
admits guests and how many guest pages are in it), each with its ⋯ from the catalogue's `adminRoom` rows: + Add room
(the Main room's New room in this hall…) and Rename… for those who set halls up, May send in…, the code and Remove room…
for the admin, Members… for whoever manages accounts; the hall's own name and Stagewatch stay Set up's form, and the hall
is closed on the admin page. No two rooms of a hall share a name, in any case, its Main
room's included, whether a room is made or renamed or the hall is set up. A room removed is taken out of every account's
rooms, and a hall removed out of every account's halls and On stage halls with its rooms (a room whose files another
program held, which comes back at the next start, stays with the accounts given it); and no new hall or room is made under
a key a room, an account or a node's link still names, so a hall made later under the same code is never open to an
account that had the one before.

**Which rooms may send into a room.** Each room has a list of the rooms, of any hall, whose people may send messages
and files into it (`settings.roomSends`, kept in `settings.json` by room key, never by guest code); a room with no list,
and a folder where none was ever set, takes nothing in from another room. The admin sets it with **May send in…** on a
room's ⋯ (the admin page's list, or a hall's Set up; a hall's Main room as any other): every hall's rooms, grouped by
hall, the room itself listed and not offered, each ticked where it may send in now, and beside each its **↔ and send
back**, ticked where this room sends into that one now, whether or not that one may send here: what the picker draws,
both ways, is what is kept. A ↔ is offered beside a tick, and stays offered, as it is, beside a room this room sends into
now (a tick taken away leaves it, to keep or take away). Save is one `room:update {code, sendFrom, sendBack}`: each key
must be a room that is here and not the room itself (an unknown one is refused in words, "No such room: …", never
dropped), each once, at most 50 (a longer list is refused, never cut); `sendBack` is every room this room sends into,
so this room is put on the list of each room it names and taken off the list of every other room that names it now (a
room it does not send into yet only beside a room ticked), and each of those lists is held to 50 too; the answer names
each room it now sends into or no longer does. A room on the list that is not open now (one whose files another program
held, which comes back at the next start) is never shown, keeps its place through a save and counts toward the 50. The
lists a change touches are saved together and written in one `room.sendFrom` row on the room's key ("may send here: Main
(Hall 2), Main (Hall 3); it sends back into: Main (Hall 3)"), the rooms by name, never by key; a change that changes
nothing is answered `already` and writes none, and settings this run could not read are never saved over (the change is
refused with why). Only those who read a room's
settings see the lists (`room:settings`: the admin, and those who set halls up, whose Set up says under each room "May send
in: Legal · Hall 2, Main · Hall 3"; every hall's rooms, `everyHall`, are told only to the admin, who alone sets them). No
page in a room is ever sent a list, nor a key of another hall's room on one. A room removed, or a hall with its rooms, is
taken off every list, as the room listed and as a room on a list (one whose files another program held, which comes back
at the next start, keeps its place for it), and no new room is made under a key a list still names. The list is read
whenever a room sends into another, so a list changed mid-show applies at once, and the pages of each room whose list of
rooms to send into changed are told to ask again (`sendsChanged`, which names nothing; also when a room it sends into, or
that room's hall, is renamed). Going back to 0.5.1 keeps the
lists in `settings.json`, unread.

**Sending into another room.** A page in a room is told the rooms whose list names its room (`room:sendTargets`): each by
its reference, a MAC of its key under the server's secret (`store.roomRef`, `store.byRef`: 17 characters that no join or
lookup takes, the same at every start), its name and its hall's name, never a key, a code, its people or its numbers; none
On stage, for a seat that may not post, or from the admin's support view. The join answer's `sends` says whether there are
any. `room:send {to, messageId}` sends a message or a file of the room; `{to, type: 'text' | 'file', text, url, filename,
mime, caption, priority, replyTo}` a new one. The rights in the room it comes from decide: the list is the admin saying
that whoever may post there may post into the other room, so the sender's seat there is not read (a Board account's file
sent from Legal, where it is a Member, goes into the Main room where it sits On stage). In order: a repeat of a send that
went through (its client id, kept on the copy) is answered with what it did and writes nothing, and a client id a message
of another kind holds is refused ("That message's id is another message's."); On stage, nothing is sent,
in either form, Send back included ("Messages from On stage stay in this room."); then the writes bucket, then posting
("Observers can read but not post."); a question or a help request is not sent ("Only a message or a file is sent into
another room."; "A help request belongs to its room — ask in the other room instead."), and a file needs `hall.files` where
it is ("Your account may not share files here.") and, when new, an upload made for that room by the sender (as `message`
reads it); a reference to no room, a removed one or the room itself is "That room is gone.", and a room whose list no
longer names this one "This room may not send there — ask an admin." The message goes into the other room first, from
the sender, marked with the room it came from (`sentFrom`: its name, its hall's name and its reference, and who wrote it
when the sender sent on someone else's), and the room it came from keeps a copy marked with where it went (`sentTo`, with
the other room's message id), so a copy exists only for a message that is there; nothing else of the other room (its
people, its replies, its seen receipts, its numbers) comes back. A reply sent back answers, in the room it reaches, that
room's own message (its copy of the question, or the question itself). A file keeps its link, which the other room's
people open as any file's; the copy's removal by its author leaves the other room's message, and a file leaves the disk
only when no room and no screen holds it. The message in the other room is not its sender's to delete there, from a page
they hold in that room too ("A message sent from another room stays here: its sender withdraws it from that room, or the
admin removes it."), so the copy's "delivered" stays true while that room holds it; the admin removes it. A file that
arrives from another room never opens itself on the On stage panel.
Each send is one `room.send` row on the other room's key, written once the message is there and before the copy.

**Withdrawing a send.** A mis-sent message is taken back from its copy (`room:withdraw {messageId}`, Withdraw from Hall 2 ›
Legal… on the copy, which asks first, naming the room and how long it has been there). A repeat of a withdrawal made,
asked by the copy's sender or the admin's own page, is answered as done (`already`) before the rate, so it is never
refused for what succeeded; every other request takes a token of the writes bucket first, then is refused, in order: a
message that is not in the room ("Message not found") or is no copy of a send ("Only a message this room sent into
another room is withdrawn."); the admin's support view ("This is someone else's view — act from your own page."); anyone
but the copy's sender and the admin's own page ("Only its sender or the admin withdraws it."); a seat On stage, the
admin's included ("Do that from a backstage page."); then the message must still be where it went, the one that came from
this room ("It is no longer in Hall 2 › Legal: there is nothing to withdraw." after a room removed, or a message the admin
removed or a reset cleared there). The message goes from the other room, and each reply there that quoted it keeps who
wrote it and none of its words ("↩ Ana: ⊘ withdrawn", a change that room's pages hear as `replyUpdate`); the room says who
took it back ("Ana withdrew a message sent from Hall 2", "… a file …"; the admin's "Ana Admin withdrew a message Lou sent
from …"); then one `room.withdraw` row on that room's key; then the copy keeps when (`sentTo.withdrawn`, a change its
room's pages hear as `sentUpdate`, in order, and a page back from a drop reads among what it missed), and reads "⊘
Withdrawn from Hall 2 › Legal after 40 s": people there may have read it, and a copy one of them forwarded or sent on
stays where it went. The copy stays: its file stays on the laptop while the copy holds it, and leaves when the copy is
deleted and nothing else holds it. Delete… on a copy not withdrawn says the message stays where it went: withdraw first,
since the copy is what takes it back.

Rules that keep rights from growing by themselves: deny by default; only an admin makes an admin or hands out
`users.manage`, `settings.manage` or `audit.export`, and only an admin changes, resets, signs out, turns back on or
removes an account that holds one of them (on the Accounts page such a person's Edit is disabled for anyone else, with the server's reason); an account that is not an
admin manages only accounts within its own rights and halls, and hands out only those — it cannot make a richer account,
widen one, or reset a richer one's password (the page offers only what it holds, names only the halls it holds — a
person's other halls are a count — and offers nothing on a richer person's row but its Edit, disabled with the reason,
which its button, its menu and the toast when it is chosen each say); nobody changes their own role, rights or
halls, nor turns themselves off or removes themselves (on one's own row the page offers Edit for the name, a new
one-time password and Sign out everywhere); the last admin who can sign in stays one. An account's acts are on its row:
Edit… as its button, and on its ⋯, right-click and Shift+F10 (from the catalogue's `account` rows) Edit…, New one-time
password…, Sign out everywhere…, Turn off… (or Turn on) and Remove…, each asked in place before it runs (Turn on asks
nothing); each goes over HTTP, and an answer not back in 5 s, the editor's Save included, says "No answer — check the
connection." The answer that comes later is still the act's, said as late, and the list is read again: a new one-time
password that comes late is shown all the same (the old one has stopped working by then), and a Save is held, never sent
twice, until it is answered. A code guest's rights come from where they joined: backstage posts, shares files and sends to Stagewatch; on
stage posts; an observer reads (in a side room, a Member posts and shares files and sends nothing to Stagewatch, and no
seat there is On stage: `rbac.guestCaps`); a role the join page does not offer is refused ("Choose On stage,
Backstage or Observer."), never seated as another. A browser signed in to an account is that account in every hall, a
one-time password not yet changed included: its code join is refused ("You are signed in as Ana: open the room from your
halls, or sign out to join with a code."), so an account never takes a guest's seat, and the rights that come with it,
beside its own; the refusal spends nothing of the code lockout. The admin's support view, and the host token's admin
(who has no account), are not code joins. Screens, halls and other show systems need an account.

**Who may show what on people's pages** (the owner's answer 10: "Board pages should be more secure and not available to
guests in an open hall. Web pages need rights of their own."). A page holds two layers: the show (Stagewatch, the clock,
holding, blank), which only the operator puts up (`display.control`, the admin, a locked hall's backstage guest), and
information over it (a web page, a document, a picture; quotes as they land), drawn over the show and never in its
place. An account seated backstage in a room of the hall may show information by a right of its own (`canShow`): with
`stage.show` (and `stage.web` for a web page), to the Board or one person seated On stage, and never anyone else ("Only
the people on stage can be shown this."). From a side room it does so only while that room is on the Main room's list
("This room may not send to the Main room's Board — ask an admin.", every kind, the take-down included). Over the
operator's information, the target's own or on any page of theirs, it is refused ("The operator is showing a web page —
ask them, or send it to their side bar.") and taken in the person's side bar instead, kept beside the operator's, where
it replaces nothing; its Take down takes down only what such a seat put up, by the take it names, and only a kind its
own rights would put up (a web page by `stage.web`, the others by `stage.show`). A page whose push holds as the
operator's reads `canShow` false: its information goes by `canPush`. A code guest of an open hall shows nothing ("In an open hall, showing the Board needs an
invite link or an account — ask the admin."), and an observer seat (a Viewer's, a Staff account's without `hall.post`)
nothing, whatever it was granted. A document or a picture also needs `hall.files` where the account sits ("Your account
may not share files here, so it shows quotes only."), and its file a place the stage may show it from: the pusher's own
fresh upload, a file of the Main room, or of a side room the pusher reads that is on the Main room's list. A document is
never shown to a person seated as an observer. **Withdraw** (a take shown by mistake, from every page and from Earlier)
is for who put the take up, the operator and the admin ("Only who showed it, the operator or the admin can withdraw
it.").

| Who | Seat | The show | Information |
|---|---|---|---|
| The admin | — | every kind | every kind |
| Tech, Senior, Manager (presets: `display.control`, `stage.show`, `stage.web`) | backstage | every kind | every kind |
| A Tech with `stage.show` taken back | backstage | every kind | a web page alone (with `stage.web`) |
| A locked hall's backstage code guest | backstage | every kind | every kind; a web page while the hall's switch is on (below) |
| An open hall's backstage code guest | backstage | none | none |
| Staff (`stage.show`) | backstage in a room of the hall (a side room on Main's list) | none | to the people On stage; a web page only with `stage.web` granted |
| An account with `stage.show` taken back and no `stage.web` | backstage | none | none |
| A Viewer granted the rights, Staff without `hall.post` | observer | none | none |
| A side room's Member guest, an On stage seat, an observer | — | none | none |

**On stage invite links.** The admin page's Roles & invites panel shows a hall's On stage link whether its roles are
open ("Open: anyone with the code joins Backstage or as an Observer; On stage needs this link.") or locked (with the
Backstage link then), and **New On stage link** (New Backstage link, a side room's New Member link) voids the link it
replaces without changing the code (`admin:newInvite`: the room's number for that seat goes up by one), keeps the seats
already held, and writes one `room.invite` row with no link in it. A new code voids every link. A hall page joined with
a link takes the code and the invite out of its address once it is in, kept for that tab alone. An open hall's On stage
seats are kept with the hall across a restart (its backstage and observer seats come from its code and are not), and
unlocking a hall keeps its On stage seats and drops the rest. The admin may still seat a code guest On stage from the
room's people list; that seat is kept the same way.

**Web pages from backstage guests** (the owner's answer S4, "Admin defined"). A code guest holds no `stage.web` of its
own. A locked hall's backstage guest (its seat from the invite link, or kept by the lock) changes what people's pages
show, and shows a web page only while the admin has that hall's **Backstage guests may show web pages on people's
pages** on (Admin → the hall → Roles & invites; `admin:guestWeb`, the hall's `settings.guestWeb`). It is off by default,
for a hall made before 0.6.0 too; it is offered on a hall's Main room only, and only while the roles are locked ("Lock the
roles first: in an open hall, code guests show nothing."); and it is "the admin's" alone: the laptop's token or an
account whose role is admin. A manager an admin granted `settings.manage` opens the admin page and is refused this
switch ("Only an admin may let backstage guests show web pages."). Unlocking the hall turns it off in the same change, and
locking again leaves it off: a lock keeps whoever sits backstage then, guests who joined by the bare code while it was open
included. While it is off a guest's web page is refused ("Web pages from backstage guests are off in this hall — ask the
admin."); turned off, or the hall unlocked, a web page a guest already put up stays until someone takes it down, and
the admin's answer counts them with Take it down (a person's whether or not a page of theirs is open: the admin's
take-down reaches the store without one). A guest's page hears a change at once (`pages:rights {canWeb}`). An open hall's code
guest, an On stage or observer seat and a side room's Member never show one.

**Who may download, and who may move a file** (plan 4-§4.6.6; owner answers 12 and 20). A download is the server's act,
by a ticket it gives a seat that may download (`lib/pages.js` `mayDownload`), never a `GET`:

| Seat | A file shared for download | A document shown with "Let them download it" | A quote or a picture of a page |
|---|---|---|---|
| The admin (not On stage) | ⬇ | ⬇ | never |
| Backstage: accounts and code guests, a side room's Members | ⬇ | ⬇ | never |
| On stage, either view | 👁 Look only ("On stage tablets keep no copies — ask the backstage team to show it to you with Download ticked.") | ⬇, on that take's card and layer alone | never |
| Observer | the card alone: no link, no picture, no Look, no ⬇ | a document is never shown to one | never |
| A Viewer account, whatever its seat (a Viewer granted `hall.post` sits backstage) | the card alone, as an observer's | never ⬇ | never |

An observer and a Viewer account are refused every ticket ("Downloads are for the backstage team."), and their pages are
never given a file message's link. A file moves to another room (`forward`, `room:send`) only from a seat that may
download it where it is, besides `hall.post` and `hall.files` there and where it goes: "Files are moved by the backstage
team." A download of a file that is not confidential writes no audit row (a person reading what their room shows them).

**Who may mark a file confidential, and who may remove the mark** (plan 4-§5.14, S16). Whoever shares a file may mark it
as it is shared (🔒 Confidential beside 🔥 Priority). Later, from the file's ⋯: someone seated backstage with
`hall.files` in a room where the file is, never a Viewer account, or the admin, from a hall page or the admin page's room
view (`file:mark`). An On stage seat shares no
file, so it marks none ("Do that from a backstage page."). The mark is removed by whoever set it, or the admin: "Only
Sue Staff or an admin can remove the mark." A confidential file goes into a room where it is not in use, or onto
people's pages there, only once its sender confirms, from a seat that may download it where it is in use, or the admin.

**Inside a hall.** Reading is `hall.view`; everything that changes what the others see — a message, a reply, a help
request, an answer to an action prompt, a pin, a reaction — is `hall.post`, so an observer or a Viewer reads, sees a
prompt's options and its tally, and is offered nothing to press. What a page offers on a message (its row's acts, its ⋯,
its right-click and Shift+F10) is drawn from one catalogue of acts (`app/public/catalog.js`), each shown by rights that
match a refusal the server words: hiding an act is never the check, and `test/menus.test.js` sends every act to each seat
it is not offered, and each is refused. Forwarding a message posts it in the other hall, so the
rights there decide: an account's rights in that room (and `hall.files` for a file), held to the seat it would sit
there, a code guest's own seat there (a
locked hall's observer seat stays an observer's), or, where the guest has no seat, the admin's link. The forward carries
the role and the account mark a post there would carry, and Send to ▸ lists only the halls that would take that
message (for a file, those where they may share files too); it is offered only where there is one (the join's
`forwardable`, asked again when the admin's link changes). A help request is not forwarded: it is tracked and
answered in its own hall. An account's role in a hall follows its rights, so
the admin page's room list changes a code guest's role and refuses an account's (that is the Accounts page's); its link
lets a code guest forward into a hall, and is refused for an account that may not post there. An account with a hall
open on a laptop and a phone (or a guest with it open in two tabs) is one person there: listed, announced and counted
once, "left" only when the last page closes, and the room list's role, link and logout reach every one of those pages.
A move between a hall's rooms (the switcher: the page left goes, and the next joins another room of the hall within the
8 s grace) writes no "joined" or "left" line in either room; a page still open in another room is no move, so a second
device or tab in Legal is said there as it joins and as it leaves. A page its tab leaves closes its connection then, so
the room it left lists the person no longer at once, even where the browser keeps that page to show again.
A locked hall's invite is for people who join later: a code guest already seated there keeps the seat while another of
their pages is open and for the few seconds before "left" (Wi-Fi drops, the page's reload after the admin changes their
role), under the same name and role; after the admin logs them out it is gone. The seat also holds across the watchdog's
restart, which drops every page at once: a locked hall's seats are saved with the hall, and a page back within the first
30 seconds after the restart takes its seat again; a seat not taken up by then is gone.

**On stage.** A seat On stage reads and writes messages, and nothing else: it sends text, replies and 🔥 Priority, asks
for help, reacts and answers the backstage team's questions (in words too, up to 200 characters). It is given no upload
token and shares no file ("On stage seats send messages, not files."), asks no question ("Questions for the Board come
from the backstage team."), and sends nothing into another room, text included ("Messages from On stage stay in this
room."): what it writes is in its room's feed, which everyone in that room reads, and its page offers no Send to ▸
(the join's `forwardable` is false On stage), whatever halls the person is in and whatever link the admin gave them. Screens, a hall's set-up, the show network
and drafts are not driven from that page ("Do that from a backstage page."; "Drafting is for the backstage team."). Help
requests are answered by the backstage team: an On stage page marks its own request resolved and nothing else, so On my
way or Resolved on someone else's, and On my way on its own, are refused ("Help requests are answered by the backstage
team."), whatever hall the request names, and the page draws neither. The server refuses each by the seat
(`rbac.SEAT_LIMITS`, and for help `help:respond`'s On stage rule, read before any right), whatever the page sends. The
limit is the page's, not the person's: it is read first, before any right, so the admin who joins a hall On stage from
the token is held to it there, while its admin verbs answer as from any of its pages and its other pages are not
limited; a guest seated On stage in one hall and backstage in another keeps backstage's rights on that page. When the
admin moves a guest's seat, the page is held to its new seat at once: an upload token it holds ends with the move, is
refused at its next use in the new seat's words ("On stage seats send messages, not files.", "Observers can read but not
post.") and is gone, and the page's join after its reload takes a new one where the seat shares files. Accounts are
seated by their rights in the room (backstage, or an observer without `hall.post`), and On stage in a hall's Main room
whose hall the account's On stage halls name, where it may post (`rbac.roomRoleFor`): the limit holds it there as it
holds any seat. On that page a Board account (a Tech given a hall's On stage seat, an admin given one) is given no
upload token, is not offered the speaker's screen or the show desk and is refused them, drives no screen or node, is
handed no guest code, and forwards nothing out of the hall; from its other pages it is the crew its rights make it, and a
file or a question it forwards from there never goes into the hall where it sits On stage. An account answers a room's
help requests, from its hall page or the halls board, only where it may post and does not sit On stage
(`rbac.answersHelp`, by the room, which the halls board's On my way and Resolved read too): a Board member of a hall
answers none of that hall's requests from any page, a side room's of that hall it would answer only as the hall's crew
included, and is told so in the On stage words ("Help requests are answered by the backstage team."), its own Resolved
excepted; it answers those of a side room it is given and of the halls where it is crew. A side room's help request (Legal) is answered by those who may post there, and by
the hall's crew, those who answer its Main room's requests: the halls board shows it whole to an account that may read
the room, and to the hall's crew who may not with its category, who asked and its state, never its words, and to nobody
else; an account given the side room alone is told its hall by name, never by the hall's key. From any room of a hall,
an account sends to the hall's speaker's screen and its show desk where it holds `stage.send` in that hall; a side
room's guest never does. The line's record keeps the link it went to, which a hall's own Stagewatch names by the hall's
key; the room's pages are sent it without that link (live, in the history and in the changes a page missed), so a send
from Legal tells Legal's readers nothing of the hall's key.

Forwarding keeps two rules of the room a message comes from: a file moves only from a seat that may share files there
("Files are moved by the backstage team."), and a file or a question goes only into a room where the forwarder sits
backstage, never where they sit On stage. Send to ▸ lists no room that would refuse the message, and when a rule of the
room it comes from leaves none, it says that rule in the same words. A guest seated both On stage and
backstage in one room forwards into it as backstage, whichever page joined first; with no seat there, the admin's link
posts and shares files (`rbac.LINKED_CAPS`).

A file message is posted only in the room its upload was made for, by the person who made it, or again in a room a
message of which holds it already: the upload token a page is given at its join names its room and its person, and the
upload keeps both. Another room's file is refused ("That file belongs to another room — send it from there."), and so is
another person's upload not yet posted; a send into a room its list lets the room send into, or a forward between rooms
the person is in and by the rules above, is how a file reaches another room. A file no room holds any more, only a screen or a hall's holding image, is chosen again to be
posted, and an upload not yet posted when AGMessage restarts is uploaded again by the page that holds it.

**Each room's guest code.** A hall's Main room's code is its key until the admin renews it, so a hall of 0.5.1 keeps the
code its guests know with nothing written; a room beside a hall gets a code of its own as it is made, never its key (an
address no join takes from a guest). A code is one room's: no live code, earlier code or key is shared, and of two rooms
on disk claiming one code the first by key holds it and the other's admits nobody (said on the console by the room, never
by the code). Whether a code admits is the room's setting: a Main room's is on until switched off, a side room's off
until switched on, so a new room is for the admin and the accounts given it. **Switched off**, a code admits nobody new:
"Turn off" keeps the guests in (one whose Wi-Fi drops comes back within the grace, and a locked room's seats outlive a
restart's first seconds), "Turn off and send them out" closes each guest page in the room ("This room is for signed-in
accounts now.") and forgets the seats it held (one meta op clears the saved seats with the switch); accounts stay either
way. **New code** gives the room a new code: the guests in stay, the code before it joins the room's earlier codes (the
newest three), which admit only a person already seated there and spend no lock (a hall of phones coming back on it
behind one address is not locked out), and the invite links, made with the code, stop. A code switched off, an earlier
code, a room's key and a code no room has are one answer to the lookup ("No hall or room has that code.") and to a join
("Room not found"); each but the earlier code counts against the lookup's and the join's locks. A code is never in an op,
the ring, a resume or an audit row: switching it is one meta op its pages hear (whether it is on, never the code) and
`room.code` row ("code off (3 guest pages kept)", "code off (3 guest pages sent home)", "code on", "a new code was
issued"); a renewal is the store's alone, written with the room's snapshot at once, and one the disk refuses is taken back
whole and refused ("No new code was made: it could not be saved. The code stays as it was."). **The residual:** until New
code, a Main room's key is its code, so its code is wherever its key is: its pages' address, the halls board's and
`/api/halls`' rows and links (read by every account that sees the hall, Staff and Viewers included), and the audit rows
that name the hall by its key (`room.code`, `hall.*`), as in 0.5.1. The admin page says so where the code is shown and
marks each such hall in its list ("code is its address"; "This hall's code is also its address: anyone with an account
in it can read it. Choose New code to separate them."). The laptop's token admin has no account, so its own page joins by
a code: it is a member of every room, admitted whether the code is on or off (or by the room's key), never counted or sent
out as a guest page, and its misses spend no lock. A side room's Member is called so on every page, and no seat there is
On stage.

**Who is told a code** (`mayKnowCode`): the admin; those who set halls up (`halls.manage`: they hand codes out); an
account whose own rights in that room already hold what the code gives (seeing, posting and sharing files there, and in a
Main room also the speaker's screen of its hall: a Tech in its halls, a Staff account in a room it is given); and a guest,
the code it typed while it is still the room's. Never a page seated On stage (a Board tablet is handed no code), a
Viewer, a Staff account in a Main room or an account of every hall in a side room it is not given. It decides the code
chip on the hall page (the join's answer, then each change), `/api/halls` and the halls board's chip (with "(off)" while
it admits nobody new), the admin's list, and a room's settings and each of its hall's rooms in them (Set up's Rooms),
where a project manager whose account sits On stage in a hall is told none of that hall's Main room's code, as anywhere
else. The admin's support view is told what the person's own page is told, and may switch nothing from it. Staff and Viewers are no longer shown a hall's code, as
they were in 0.5.1 (owner question 8: "Right").

**Who is told a hall's code, elsewhere.** A code lets anyone in as a guest (backstage in an unlocked hall, an observer in a locked
one), so it goes only to those who may open that hall: the halls board, the show network's list and the Accounts page
name only the halls an account reaches (an account that does not reach every hall sees another person's other halls as
a count); a screen's link only shows, and its connection is never told its hall's code (Identify on a hall with no name
draws no hall); the admin's link that lets one guest forward into another hall reaches that guest and the admin's pages,
never the rest of the hall; a forwarded message names the hall it came from, never its code ("another hall" when that
hall has no name). The audit log names halls by their code: `audit.read` is a right over every hall (a project
manager's and the admin's), so an admin who gives it to someone of one hall gives them every hall's code.

## The first admin

A new AGMessage has no accounts. Open it **on the AGMessage laptop** (`http://localhost:3023`): the sign-in page asks
for **the laptop's admin token** and the first admin's name, username and password. "On the laptop" means a request
from the laptop's own loopback, addressed to `localhost`, `127.0.0.1` or `[::1]`, with no proxy or tunnel headers — a
page served under any other name is refused, even when that name leads back to the laptop. Loopback alone is not
enough: a second Windows account on the laptop reaches it too, so the first admin is made only with the token, typed
into the form, or, when none is typed, by the token's sign-in made by this run at the laptop (one read back from
`admin-sessions.json` after a restart is a record anyone who could write the data folder could add, and does not
count). The sign-in page always asks for the typed token (its field is required, of any length); the token's sign-in
serves a request made without the page's field. A token typed is always judged, whatever sign-in is beside it, and
judged first: a wrong one is refused, counted toward the token's lockout (5 a minute) and written as `login.token.fail` "a
wrong admin token (at setup)"; while the lock holds a wrong one is refused and not written again, and the right one is
still taken, so nobody else at the laptop keeps its person out by typing wrong tokens. That leaves guessing at the
laptop unbounded until the first admin exists: the watchdog's token is 64 random bits, and a portable copy given its
token by `ADMIN_TOKEN` is as strong as that token, so the papers ask for 16 or more random letters and digits. This
PC's machine at loopback is answered only for a token of 16 characters or more: its hello is an HMAC under the token
over words its asker knows, so any program on the PC could test guesses at a shorter one offline, outside the lockout
(`SECURITY.md`). The `setup` row says which way the token came. There is one first admin, even when two requests arrive at
once. The admin then adds everyone else on the Accounts page (Halls → Accounts); each new person gets a **one-time
password**, shown once, which they replace at their first sign-in (two saves at once still make one account). The host
laptop's admin token still opens the admin page there; that sign-in lasts a day and survives a watchdog restart, which
keeps the token, but not a fresh start of AGMessage, which makes a new one.

On a PC where AGMessage is installed, the installer's last page makes the first admin account the same way, once the new
node answers and while it has no account: the installer reads the token from the node's token folder (an elevated
installer may) and `machine.js first-account` sends it typed with the name, the username and the password to
`/api/setup` at the laptop's loopback, only once the server there has proved it holds that token (the machine's hello)
and only on the connection it proved itself on, so a program that took the port is sent neither; the server's own
rules (no account yet, the laptop, the token, the password's checks) decide and its `setup` row is "with the token
typed". The password reaches `machine.js` in a file only SYSTEM
and Administrators may read, which it removes before it asks, and is never in a command line, a URL or the installer's
log. Left empty, the first admin is made at Admin login as above, with the token from Start → AGMessage → Show the
admin token. The Windows account that ran the installer is **the laptop's admin** (a Windows account, `docs/INSTALL.md`),
not an admin account: it reads the token, and an admin account is AGMessage's own.

**Where the token is said.** The watchdog makes the token and says it only where a person sits: the banner's Token line,
under Admin login, holds it in a console window (the portable folder's black window), and never in output that is kept
(redirected to a file or a log), where the line says how to see it instead. A server run without its watchdog prints its
own. The installed node has no window: its watchdog writes the token into `admin-token` in its token
folder (`AGM_TOKEN_DIR`, `%ProgramData%\AGMessage\token`), once its server serves. That folder is one of its own, which
this PC's AGMessage admin (the Windows account that installed it) and the accounts it gives `token` may read (the
installer's units set its access list and add the Start menu; no build installs AGMessage yet). Start → AGMessage → Show
the admin token runs `launch.js token`, which prints it in the person's own console, or says "This PC's AGMessage admin
has not given you the token: ask LAPTOP\ana". The file is replaced whole each time the node serves and is left when it
stops, so the token it holds is the one the node last served with. The installed node takes no `ADMIN_TOKEN` (nor
`ANTHROPIC_API_KEY`) from its environment: a scheduled task's definition is read by every account allowed to read the
task, so either one there stops it with code 3.

## Passwords and sessions

- scrypt with N = 2^15, r = 8, p = 3 (32 MiB, about a quarter of a second on a show laptop), two at a time so a burst of
  sign-ins never stalls a hall; raised later without anyone noticing (an older hash is redone at the next sign-in).
  A sign-in through the tunnel uses one of the two at most, so sign-ins on the venue network always have the other; each
  side waits in a short queue of its own, a sign-in past it is told "Sign-in is busy — try again in a moment", and one
  whose page has given up is dropped without being checked.
- At least 10 characters, at most 128; not a common password, not the username or the person's name. A few words
  together is the advice on screen.
- Five wrong passwords for a username in 15 minutes hold that username where they came from — one device on the venue
  network, or the whole Cloudflare tunnel — until 15 minutes after the first of them; twenty from one address hold that
  address. The AGMessage laptop is never held back by another device's wrong passwords, an admin's new one-time
  password ends the wait, and a signed-in person changing their own password counts only their own tries. An unknown
  username, a wrong password and a turned-off account take the same time and get the same words.
- A session is a random 256-bit token in a cookie the page's script cannot read (`HttpOnly`), never sent by another
  site (`SameSite=Strict`), only over HTTPS when the page is (`Secure`, through the Cloudflare tunnel too). Only its hash
  is stored. Idle for 14 hours or 7 days old, it ends; a page left open counts as in use, so a hall or the halls board
  open all day stays signed in. An account keeps its 20 newest sessions (a 21st sign-in ends its oldest), so one account
  signing in again and again never signs anyone else out. Signing out ends that session and closes the pages open on it;
  changing a password, turning an account off or "sign out everywhere" ends every session of that account at once — and
  closes its open pages, which reconnect with the rights it has now. The Accounts page counts only the sessions that
  still sign in.
- Every state-changing request must come from AGMessage's own pages (the `Origin` check).
- Through the Cloudflare tunnel, accounts with admin rights (`users.manage`, `settings.manage` or `audit.export`) cannot sign in, nor use
  those rights on a session they already have, unless the admin turns on "Let accounts with admin rights sign in through
  the Cloudflare tunnel" (Admin → Accounts and access); turning it off ends admin rights on every page open through the
  tunnel at once. Such a sign-in is answered as a wrong password is, so the tunnel never tells a stranger that a password
  was right.

## The audit log

`data/audit.jsonl`: one line per action that matters — sign-ins (and failed ones), the first admin, accounts and rights,
halls and their Stagewatch, the admin's room controls (a hall made from the admin page or over HTTP, its messages cleared
with the files that left the disk, the takes it ended on people's pages and its stage record cleared (a side room's: the
entries sent from it dropped from its hall's, "…, 2 entries dropped from the stage record"; a record whose file could not
be read at the start, "…, the stage record not cleared on disk: its file could not be read (EBUSY)"), a message removed with whose it was and its kind, a guest's role, roles locked or
unlocked with the seats kept, a guest let forward into another hall or no longer (that hall by its name, never its
code), a person sent out, the AI's minutes posted, a hall removed (`hall.remove`, with how many other rooms went with it,
how many accounts were given it or its rooms no more, and its rooms by name and key, each of which has its own
`room.remove` row first) or a hall's side room removed alone (`room.remove`, by its name and its hall's, and the accounts
given it no more), each saying the files of any room
another program held as they were removed, kept, and whether it opens again at the next start: one row for each change, none for a
control that changes nothing), a hall's rooms (`room.create`: "Legal in Hall 2 (code off)"; `room.update`: a side room
renamed, "name → Media"; a hall's Main room renamed is `hall.update`, as its Set up writes it), an account's side rooms,
On stage halls and chat view (`user.create` and `user.update`: "rooms → Legal (Hall 2) LGQ4MZP8", each room by its name,
its hall's and its key, never a guest code; "board → On stage in H7K2QA"; "view → simple", "view → by seat", from the Accounts page or the admin's Chat view alike), a guest's chat view set by the
admin (`person.view`, by the hall's key: "Rita (guest) → simple view", "… → the view by their seat"; one row for each
change, none for one that changes nothing), the clock or countdown the admin chose and its lock (a guest's `person.clock`,
by the hall's key: "Rita (guest) → clock: countdown, locked", "… → clock: countdown, unlocked", "… → clock: their
choice"; an account's `user.update`: "clock → time of day (locked)", "clock → their choice"; every lock and unlock a
row, none for a choice as it stands, none for a device's own choice), the admin's reads of a
side room its account is not given (`room.read`, once each: a page entered, never a resume; a watch begun; a transcript;
a person's view opened; the AI asked for its minutes, its messages handed to it whatever it answers; the laptop's token is given none, so its reads always write one; never
what was read), a room's guest code switched or renewed (`room.code`, by the room's key: "code on", "code off (3 guest
pages kept)", "code off (3 guest pages sent home)", "a new code was issued"; never the code), which rooms may send into a
room (`room.sendFrom`, by the room's key, one row for every list a change touches: "may send here: Main (Hall 2), Main
(Hall 3); it sends back into: Main (Hall 3)", "it no longer sends into: …", a room on the list not open now counted, "2 rooms
not open now"; each room by its name and its hall's, never a key), each message or file sent into another room
(`room.send`, by the key of the room it went to: "a message (212 characters) from Legal (Hall 2) to Main (Hall 2)", "a
file (pdf, 2.1 MB) from …", "a confidential file (pdf, 2.1 MB) from Legal (Hall 2) to Main (Hall 2), confirmed" for a
confidential file sent or forwarded into a room where it was not in use; never its words or a file's name), a file marked
confidential or its mark removed (`file.mark`, by the room's key: "a pdf in Legal (Hall 2) marked confidential", "a pdf
in Legal (Hall 2): the confidential mark removed", "… marked confidential as it was shared", by the hall's key "a png shown
on people's pages in Main (Hall 2) marked confidential as it was shown", and "a png drawn of a confidential file, marked
confidential as it was uploaded in Legal (Hall 2)"; never its name), a confidential file's download as its stream ends
(`file.download`, by the room's key: "a confidential pdf downloaded in Legal (Hall 2)"; other downloads are not
audited), the admin's transcript read with a confidential entry's words off the laptop (`room.read`: "…, confidential
text included"), each send withdrawn (`room.withdraw`, by the key of the
room it went to and was taken from: "a message sent from Legal (Hall 2), there 40 s", "a file …", the admin's "a message by Lou sent
from …"; never its words or a file's name),
each upload its check refused (`upload.refused`, by the hall's key, the uploader's row: what the file was refused for and
the bound it broke, "a docx: 12,000 parts (bound 2,000)", "a docx with macros", "an xlsx: a part packed 1,016:1 (bound
200:1)", "a png of 400 MP (bound 100)", "a jpg whose size cannot be read", "a docx that could not be checked"; at the
upload's own address; never the file's name),
screens (made, renamed, re-linked, removed, and every take: which screen, by whom, and what kind of thing — "a warning
(28 characters)", "a PDF at p. 3", "an image" — never the message's words or the file's name), every take on people's
pages (`page.push`, by the hall's key: whom, "the Board (6 pages)" or the person's name, and what kind of thing, "the
clock", "a holding slide", "a web page on vote.example.com", a web page by its host alone, "a PDF at p. 12", "a picture
of a PDF page (p. 12)", "a Word document at ≈ p. 3", a file by its kind alone, never its name, "a quote (a table cell, 18
characters) from a spreadsheet", "a quote (typed, 42 characters)", "a quote from a web page on vote.example.com", a quote
by its unit, its size and its file's kind alone, never a word of it, "a confidential PDF at p. 3" for a
confidential item, ", confirmed" where its pusher confirmed showing it where it was not in use, "the information taken
down", ", in their side bar" for an arrival there, ", sent from Legal" from a side room, ", withdrawn" for a withdrawal,
one row for each of whom it was for; one row per take, none for its
repeat or for a person's Back to chat or Minimise, which their own page says to the console), the hall's switch for its
backstage guests' web pages (`room.guestWeb`, by the hall's key: "backstage guests may show web pages", "backstage
guests may no longer show web pages (1 shown now stays until taken down)"; an unlock that turned it off says so in its
`room.lock` row, "roles unlocked, guests' web pages off", with the same count of those that stay), a new invite link
(`room.invite`, by the room's key: "a new On stage link (the old one no longer admits)", never the link), settings (which ones,
never their values), every proposal Stagewatch's show desk takes (who asked, for which screen, how many characters and
the desk's number, never the words), every line Stagewatch takes for the speaker's screen sent straight to it
(`stagewatch.send`: who sent it and how many characters, never the words; an emoji counts as one character in both; a
line that went with a push says so, "…, sent now, with a push", and its proposal "…, with a push — proposal p3"; a
confidential one "…, a confidential line"),
commands to Patterns and PlayMap, the internet link (`tunnel.on`: who turned it on and its end, once cloudflared gave
its address; `tunnel.until`: its end moved; `tunnel.off`: who turned it off, or kept it off with only its end left; and
system rows, `tunnel.again`: turned on again by a start inside its end, and `tunnel.ended`: turned off at its end; never
its address), a start by another build than the one that last wrote the data folder
(`server.upgraded`, a system row: from which build to which, older or newer, and the copy of the folder kept when its
format moved; `data/format.json`, `lib/dataformat.js`), a busy server stopped by this PC's machine with a reason a
person typed (`server.stop.forced`, the laptop's token holder's row: who asked, for what, what was live in counts and
the words typed; a stop of a server that is not busy writes none), and a wrong proof of the admin token at loopback
(`login.token.fail` "a wrong proof of the admin token (at /api/machine/busy)", counted toward the token's lockout as a
wrong token is; `lib/machinewire.js`).

**Chained with a key.** Each line carries the hash of the line before it, from a fixed first hash, and its own
HMAC-SHA256 under a key derived from this machine's key (`machine.key`, outside the data folder: `lib/secretbox.js`).
Each keyed line also names its log (`l`, a random id given when the log is first keyed) and the key (`k`, an id that is
not part of the key). An edited, removed, reordered or relabelled line, or one written by someone without the key, does
not check. At 20 MB the file is set aside as `audit-<time>.jsonl` and the chain goes on in a new one. The rules that need
no key (what a whole line is, the links, the runs and boundaries below) are one file, `app/verify/auditrules.js`, which
a checker on another computer can run as the laptop does.

**Its records live outside the data folder**, beside the key (`<key folder>\audit\`, MACed under a second derived key):
the head (the newest entry on disk, once its fsync returned), the log this laptop wrote last and where, which log each
file path last held, and whether this laptop has keyed a log before. They are read once, when the log is opened, and
compared with it: entries removed while AGMessage was stopped (`audit.cut`: "entries 1201 to 1630 are missing: this
machine recorded entry 1630; the log ended at entry 1200"), a log that forked, a whole log removed or another put in its
place (also across a move to a new folder), a head changed, missing or under a key this laptop no longer holds, and a
record that could not be read (a backup tool holding it) are each written as an entry of their own (`audit.cut`,
`audit.head`), a line in the black window and in health, and a finding of every check until accepted. The entry this
laptop recorded last, found with the hash it recorded but under another key id, is a changed entry: ✕ at every check
from then on, never a span and never accepted. A record that could not be read is never written over that run (while the
head cannot be read, its lane stays off for the run). The records are written only once the log holds an entry on disk
that carries its id, so a start that wrote nothing leaves the records of the log before it as they were. A log moved to a
new folder (a portable upgrade) is followed by its id, and `audit.moved` says where it was. A half-written last line
left by a power cut is kept aside as `audit-torn-<time>.bin` before it is cut.

**Runs.** The key changes only at a boundary entry under the new key that names the run before it: `audit.keyed` (the
plain entries of AGMessage 0.5.1 and earlier, from entry 1), `audit.rekey` (entries under a key this laptop does not
hold: another computer or Windows account, or a run without its key), `audit.unkeyed` (plain entries after keyed ones:
0.5.1 again, or anyone who could write the folder) and `audit.keyless` (a run whose machine key could not be read: it is
keyed with a key of its own and marked in the key folder, so the next run says "written here while this machine had no
machine key"). The entries not under this laptop's key are a span, and what this laptop says of them comes from what it
holds, never from what the entries claim.

**An entry's menu.** Each entry of Accounts → Audit log has its ⋯, right-click and Shift+F10 (the catalogue's `audit`
rows, `audit.read`): Copy this row (its mark's shape first; a row holds no secret, by rule), Only this actor and Only this
target (the list kept to that actor's or that target's entries, said above it with how many are shown; Show all brings
the rest back), then Check the log, Export the log… (`audit.export` with `audit.read`) and, on an `audit.archive` entry
and for the admin alone, Split the log here…, asked in place with the word **split** typed, as on Admin → Health, and
run as long as the split takes ("Splitting…" meanwhile), then the log read again.

**The four marks.** **Accounts → Audit log → Check the log** reads every file, oldest first, as one chain and answers
with one mark, each drawn with its shape:

- **✓ Intact**: every entry keyed on this laptop, checked.
- **◇ Linked**: entries not under this laptop's key, accepted on the laptop; the rest intact. Never ✓.
- **△ Not vouched for**: a span not yet accepted (the first start's 0.5.1 entries included), a head under another key or
  that could not be read, a run without the machine key, or the head's save failing.
- **✕ Broken**: a line that is not a whole entry, a broken link or MAC (named by its file and line), or an open finding
  of entries missing, a fork, another log, a changed or missing head.

Each row of the list carries its mark too, set when the log is opened (its MAC checked) and as each check finds the
spans; a line that is not a whole entry is listed as one, never as an entry. A page that reads only the check's `ok` sees
no ✓ for ◇ or △: `ok` is true only for ✓. The whole log is checked once at each start: what that check finds that the
start did not (a finding an earlier start left open, a line changed while AGMessage was stopped) is said in the black
window once it answers, and a check broken at a line is what health and Admin → Health read, ✕ with its line and nothing
to accept, until a whole check replaces it.

**The first start of 0.6.0 asks.** On a log from AGMessage 0.5.1 or earlier, its entries have plain hashes, and anyone who
could write the folder could have rewritten them. The black window asks, under the token that answers it, and Admin →
Health asks the person at the laptop; the browser opens on the admin page. The log reads △ until accepted. Nothing waits
for the answer: sign-ins, takes and sends go on.

**Accept is the laptop's token, typed.** Admin → Health, signed in with the token on the AGMessage laptop, shows each
open finding with its own tick: △ ones ticked, ✕ ones unticked, each ✕ accepted only with a second tick that says what
accepting it means (entries accepted as missing cannot be brought back). Accept the ticked takes the token typed again,
because a token sign-in is a record in the data folder that anyone who can write it could add. A wrong token counts
toward the token sign-in's lockout and is written down (`login.token.fail`). An admin account sees the findings and
where to accept them, with no button. The acceptance is an entry of its own (`audit.accept`, its target the findings'
ids), and takes effect once that entry is on disk.

**The export, checked on another computer.** Export… on Admin → Health and Accounts → Audit log makes one zip as it
streams (`POST /api/audit/export`), and AGMessage keeps no copy. It holds every file of the log byte for byte, up to and
including the export's own entry; `manifest.json` (the log's id, the key id, the range, the head, and the laptop's own
check run through those very bytes: its mark, words and findings); `SHA256SUMS` over every file; `SHA256SUMS.sig`, an
Ed25519 signature by this laptop's signing key; `signing-key.pem`; a README; and the verifier (`verify/`). The signing
key is derived from the machine key when an export signs and is never stored, so it changes only when the machine key
does. Its fingerprint (SHA-256 of the public key, 64 hex characters in 16 groups) is printed in full in the black window
("Signing key:"), on Admin → Health with Copy, and under Accounts → Audit log: copy it into the show's paperwork. The
export is an audit row of its own: `audit.export` first, on disk before any file is listed, then `audit.export.sent`
with the zip's SHA-256 once the last byte was handed to the system, or `audit.export.fail` with why. One export runs at a
time; a run without the machine key is refused (nothing can be signed), and writes nothing. Admin → Health names the
last export ("Last export: entries 1–1702, sent whole at 18:40 on 26 Oct (Ana). Export at the end of each show day."),
read again from the log at each start. Export at the end of each show day and keep the bundle off the laptop: if the
laptop is lost, the exports kept elsewhere are what can still be checked.

- **Who:** an account holding `audit.export` and `audit.read` (the admin role; others only by an admin's grant), and
  the laptop's token at the laptop, its sign-in made by this run (a sign-in from before a watchdog restart is refused).
  From another device only over HTTPS: the bundle holds the names and addresses of the whole log. Through the tunnel
  only when admins may sign in there. Never a code guest, a screen, a node or the context token. An account may export
  though only the token may Accept: an export changes nothing the check reports, it carries it.
- **What it holds:** names, addresses and what each did; screen takes written before 0.6.0 can also hold a message's
  first words and a file's name, which this version's rows never write. The dialog says so. Cancel (or Escape) while
  the export is made stops it: the request is aborted, the log writes `audit.export.fail` if the bundle was not yet
  sent whole, and nothing is handed to the browser to save.
- **Checking it:** take the verifier from the release the manifest names (`agmessage-audit-verifier-<version>.zip`,
  its SHA-256 in the release's `SHA256SUMS`), not the copy in the bundle, which came from the laptop under check (run
  from the bundle, it says so; run from the release, it names any bundled verifier file that differs).
  `node verify-audit.js <the extracted folder> --fingerprint <64 hex>`, or `verify.html` in a browser (one file that
  loads nothing and sends nothing; Chrome or Edge 137, Firefox 129, Safari 17 or newer). In order: only the bundle's
  fixed paths are read (a path holding `..`, a backslash, a drive letter or a NUL, a link, or a file not listed ends the
  check before anything else is read); the key's fingerprint against the one you give; the signature over
  `SHA256SUMS`; every file's digest, the log's included, before any entry is read; the entries (whole lines, links,
  the plain hashes, the runs, and the last entry the export's own). Exit 0: signed by the expected key and whole, and
  the laptop said ✓; 1: ◇ or △; 2: ✕, the log was broken when it was exported, which is also the answer when every file
  matches its signed digest, the last entry is the export's own, and the entries break at or after the line the
  laptop's own signed check named (as an archive's failure its verdict names is code 2); 3: a step failed, the entries
  break where the laptop's verdict does not say, or the key is another's, and nothing in the bundle is vouched for; 4:
  whole and signed consistently, but no key was given to compare with, so not shown to be the laptop's. `--list` prints
  the entries; `--earlier <folder>` compares with an export kept off the laptop: every entry it held must be in the
  later one byte for byte, and an earlier export whose entries break holds none to compare with (exit 3). A file the
  bundle does not list ends the check (exit 3): check it before browsing the folder, since some desktops add their own
  (macOS Finder writes `.DS_Store`), or extract the zip again. By hand, in the folder:
  `openssl pkey -pubin -in signing-key.pem -outform DER | sha256sum` (compare with your record),
  `openssl pkeyutl -verify -pubin -inkey signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig`,
  `sha256sum -c SHA256SUMS`.

| An auditor can conclude | Because |
|---|---|
| Every file in `log/` is byte for byte what this laptop's AGMessage exported at `made`, and nothing was added, removed or changed since | the signature over `SHA256SUMS`, and the digests |
| The laptop's own keyed check, run for this export through its own entry, said `<mark>` with these findings | the manifest is a signed file |
| Each line is a whole entry, `seq` runs without a gap, each links to the one before, the plain-hash entries' hashes hold, and keys change only at named boundaries | checked by the verifier, with no key |
| Who exported, and when by the laptop's clock | the last entry, and the manifest |
| With an earlier export kept elsewhere: the entries it held were not rewritten since, even by the key's holder | the compare |

| An auditor cannot conclude | Because |
|---|---|
| That each keyed entry's MAC is right | the key never leaves the laptop; this rests on the laptop's signed verdict |
| Anything about someone who can change AGMessage's code or start script on the laptop, controls its Windows account, or holds a copy of `machine.key` | they can write entries that check and sign an export of them. The signature proves "this key", not "this person", nor that the words are true |
| When an entry was really written | `at` and `made` are the laptop's clock |
| That the log is complete after the export, or that nothing was removed while AGMessage was stopped | only the laptop's records see that, and they are reported in the verdict |
| That the fingerprint is this laptop's | only the auditor's own record of it shows that: the banner or Admin → Health read in person, the show's paperwork, or an earlier export kept off the laptop |
| That entries keyed elsewhere, or the plain-hash entries, are genuine | they are linked, not checked; the verdict names who accepted them and when |

**The log carries on across events.** It stays one chain from event to event. Archiving an event writes an archive
point, `audit.archive`, as the first line of a file of its own (what waits is put on disk first, then the current file is
set aside): its target names the event archive's folder and the run of entries it stands in (`<folder>;<key id>:<first
entry>`), so a split there moves whole files and never rewrites a line. Without a split a point is an entry like any
other. (Archive this event…, which writes it, comes with the installed node's events; until then nothing in AGMessage
writes a point.)

- **The split is the admin's** (the laptop's token, or an account whose role is admin; through the tunnel only when admins
  may sign in there; never a manager, even one granted `settings.manage`): Admin → Health → **Split the audit log…** lists
  the points in the live log, newest first, each with its event and the entries a split there would move, or why it
  would not. Choose one and type the word **split**. `POST /api/audit/split {seq}` (and `GET` for the list) runs, in this
  order, the check through the files' handles; the archive made aside (`audit-archive\.<name>.partial\`: `archive.json`,
  `signing-key.pem`, `SHA256SUMS` over them and the files to move, and `SHA256SUMS.sig`, signed by this laptop's
  signing key); `audit.split`, its target the point and the SHA-256 of the archive's `SHA256SUMS`, on disk before
  anything moves; the files before the point renamed into it, oldest first (one volume: no byte is copied); the folder
  renamed to its name; the head saved at once. Nothing is deleted, and AGMessage has no act that removes an archive.
- **It is refused, with words and before anything is written,** in a run without the machine key; while an export
  streams or another split runs (who, and since when); at an entry that is no archive point under this laptop's key in
  the live log, or is its first entry; at a point that is not the first line of its file (the disk refused entries when
  it was written) or does not say where its run began (the head could not be read when it was written); while anything
  before the point is open ("Accept them first") or broken; while the head cannot be read or saved; while entries wait
  for the disk; and when an archive of that name exists. An export asked while a split runs, and a check, wait for it.
  An entry once chained is never withdrawn: when the disk refuses the split's own entry, the folder made aside is kept,
  nothing has moved, and the split waits (△ "The split waits"); once the entry is written, ahead of the next one, it is
  a split not finished, completed as below, and never reads as an archive gone.
- **The archive** is `app\data\audit-archive\audit-<the log's id, first 8 hex>-<from>-<to>\`: the files it moved under
  `log\`, byte for byte, and `archive.json` (who split it and when, the log, the key id and the signing key; its range;
  the entry its first follows; the archive point after it; the archive before it, by name, pin and split, so the archives
  chain back to entry 1; the laptop's check of the range at the split, ✓ or ◇, each closed finding naming the accept that
  closed it, which may lie after the point; and its files). It is under the data folder, so it moves with it, and never
  inside an event's archive. Leave it where it is.
- **After a split the check starts at the point** and names every archive: the walk must meet a keyed `audit.split`,
  under the point's own key, that names the live log's first entry (files removed by hand, or a split written in plain or
  under another key, leave "entries 1 to 2003 are missing: no split names entry 2004", ✕). Each archive is looked at, not read again: its `SHA256SUMS` against the split's
  pin, its `archive.json` against its line there, and each file's size. One gone reads ✕ "not where the split put it",
  one changed ✕ "not what was split off" (a file cut, missing or of another size, `archive.json` or `SHA256SUMS` changed);
  each is a finding (`a<the split's entry>`) accepted with the token and its own confirmation, ◇ after. An archive gone
  takes the older ones it named out of reach: Accounts lists those folders as "not reached from the live log", each
  with its own Check. **A split never changes the mark:** it is the worst of the live log's and each archive's own, so an
  accepted 0.5.1 range stays ◇ once archived, and the log reads ✓ only when every archive was ✓. Black window: "Audit log:
  keyed (key …) · from entry 2004, 1 archive", a line of its own once the check at start answers. Health: `saves.stores.audit.from` and `archives` (a count), before
  `lastExport`; `/api/audit` gains `archives` and `unreached` at its end; the check's answer gains `from` and `archives`
  at its end.
- **A stop part way** leaves every state read whole: while a `.partial` folder a keyed split pins is there, the check
  reads its files first, then the live ones, as one chain, and reads △ "the split at entry 2010 is not finished: 1 file
  still to move (EBUSY)" (every file moved: "its folder is not renamed yet") — a condition, never accepted. An export is
  refused until it is finished ("finish it first (Admin → Health)"), so no bundle holds a half-moved split. The next start
  finishes it (`audit.split.finished`), as does Finish the split on the same dialog. A `.partial` folder no split pins was
  made before its split was written and holds no log file: the next start removes it (`audit.split.fail`, "nothing was
  moved"). One that holds a log file no split pins is left as it is, and said in the black window and on Health. Whether
  a split pins a folder is read only from a check that walked the log to its end: after one that broke, every such folder
  is left as it is, and said, never removed.
- **An archive is checkable on its own.** On the laptop, its Check (Accounts → Audit log, `GET /api/audit/verify?archive=
  <name>`) reads its signature by its own key, its files against its `SHA256SUMS`, its entries from the one its first
  follows, each entry under this laptop's key by MAC, then what pins it — its `SHA256SUMS` must be the one the split
  pinned, and an archive under this laptop's key id must be signed by this laptop's key, or it reads ✕ as the routine
  check does — and the archive point after it here. One the chain no longer reaches reads ◇ at best under this laptop's
  key and △ under another, since nothing in the live log pins it. Two Checks of one archive share one walk, which lets
  the show go on as it reads. Off the laptop the folder is
  signed as an export is: `node verify-audit.js <the archive folder> --fingerprint <64 hex>` or `verify.html` answers 0 or 1
  by its verdict at the split, 3 on any failure or another key, 4 without a key; the three commands below work in it.
- **Every export carries them** (`archive/<name>/…`, every file byte for byte, in the bundle's `SHA256SUMS` too), and the
  manifest lists each (`archives`, at its end: name, range, the split's entry, its pin, and whether it is in the bundle).
  The export's own check hashes every archive file in full: one not what its `SHA256SUMS` says is the verdict's finding,
  and the bundle carries it as it is (exit 2). The verifier reads the archives first, oldest first, then `log/`, as one
  chain from entry 1: each archive's own signature (by another key: named, not failed — the machine key changed after the
  split), its files, its pin and the archive before it. An archive accepted as gone is listed with its pin, and the bundle
  then begins at the point after it ("entries 1–2003 are not in this bundle … no longer on the laptop (accepted at entry
  2604 …)").
- Going back to 0.5.1 after a split: it reads "✕ Broken at line 1 of audit-<time>.jsonl: entries 1 to 2003 are missing
  before entry 2004", since it knows no archive, writes on in the live log and never touches `audit-archive`. Back on
  0.6.0, its entries are a span (`audit.unkeyed`), △ until accepted, and the archive is named as before.

**What it still cannot show**, and the check does not claim:

- anything done by someone who can change AGMessage's code, its Node or its start script, controls this Windows account,
  or administers this machine. In the portable layout that is anyone who can write the AGMessage folder, which holds
  `app\data`: they can run code that holds the key, and then AGMessage says whatever they make it say;
- a whole machine restored from one image, with the key, the records and the data all from one moment;
- which person acted, when the actor can write the data folder (they can add an account or a sign-in and act through the
  server; the entries that causes are genuine);
- the earlier entries of a log first seen keyed here (a 0.5.1 log, a folder moved in, a log written before the key was
  replaced): linked, not checked, △ until accepted;
- the newest entries removed after a crash, in the 200 ms between their fsync and the head's save (longer while a head
  save fails, which health names).

Two Windows accounts running one portable folder each have their own key, so each switch writes `audit.rekey` and each
needs Accept: one account runs the show. Laptops cloned from one image share one key, and so one signing key. A rebuilt
Windows profile or a new laptop turns the earlier entries △ until accepted and changes the signing key, and anyone
holding a copy of `machine.key` can write entries that check and sign exports of them.

Going back to 0.5.1: it reads a keyed log as "✕ Broken at line 812: entry 812 was changed after it was written" and
writes on with plain hashes; back on 0.6.0, those entries are a span (`audit.unkeyed`), △ until accepted. 0.5.1 has no
export; a bundle already made stays checkable with the release's verifier.

Each entry is flushed to disk before the action is acknowledged (Clear messages' once its files have left the disk, so
that it counts them: a stop in that moment keeps the clear without its row). When the disk will not take it (full, or
the file held by another program) the action still goes ahead — a full disk must not stop sign-ins or takes during a
show — the entry stays in the chain in memory, the console and the admin page's health say so, and it is written ahead
of the next entry (or when the server stops), so what is on disk stays one whole chain; a stop puts the waiting entries
on disk first, then the head that covers them, then every other store. A half-written last line left by a power cut is
kept aside, cut at the next start, and the cut is recorded as an entry of its own (`audit.repair`). The log and its
records never carry a password, token, key or screen link, nor a message's text or a file's name (but for the screen takes 0.5.1 and
earlier wrote, which quote a message's first 60 characters and name the file): a failed sign-in under a name that is no
account is written as "(unknown username)", since what was typed may be a password in the wrong box. Project managers
and admins read it.

## Where it lives

`app/lib/rbac.js` (the rights, pure), `app/lib/accounts.js` (accounts, hashing, sessions), `app/lib/http-accounts.js`
(the routes), `app/lib/audit.js` (the chain, its records, the check and Accept, the archive point and the walk from it),
`app/lib/auditarchive.js` (the split, its finish at a start, an archive's own check), `app/lib/auditexport.js` (the
export) and `app/lib/zip.js` (the zip it streams), `app/verify/` (the rules that need no key, `auditrules.js`; the Node
verifier, `verify-audit.js`; the browser verifier's page, `page.html`, `page.js`, `page.css`), `app/public/audit-export.js`
(the export's dialog), `app/lib/secretbox.js` (the machine key and the keys derived from it). Tests:
`app/test/accounts.test.js` (rights, accounts, hashing, sessions), `app/test/sessions.test.js` (signing in, the tunnel,
the pages a session has open, restarts), `app/test/audit.test.js` (the keyed chain, its records, Accept),
`app/test/auditexport.test.js` (the export, the verifier, who may export) and `app/test/auditarchive.test.js` (the
archive point, the split, its refusals and its finish, archives in an export, who may split).
