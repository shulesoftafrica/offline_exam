# Running an offline exam in the lab

One page for the invigilator and the ICT officer. Everything here is what the app itself
says on screen; nothing needs a terminal.

---

## Before the students come in

1. On every machine, open **https://exam.shulesoft.africa** while the internet is on.
   The first visit installs the app; after that it opens with the internet off.
2. Use the **same browser profile** every time on a given machine. The exams, answers and
   files live in that profile — a different profile is a different, empty computer.
3. Leave the internet **on** until step 3 below.

## During the sitting

**1. Each student signs in** with their normal ShuleSoft username and password (and the
school code written on the board, if the machines ask for one).

**2. Each student opens their exam and presses "Download exam".**
Wait for the green line: *"This exam is fully downloaded… The internet can now be switched
off."* Pressing **Start exam** is what starts the countdown — not the download.

**3. Switch the lab's internet off** once every machine shows that green line and every
student has pressed Start.
The header changes to *"No internet (normal during the exam)"*. That is correct.

**4. The students work.** Every answer says *"Saved on this computer"* as it is stored.
A machine that restarts loses nothing: the student signs in again (their login is remembered
on that machine), opens the exam and carries on — the clock has kept running, including the
time the machine was off.

**5. "Submit exam".** The student sees a confirmation screen with the time used, how many
questions were answered and a receipt code, and the line:

> *You can leave the room. Your answers are stored on this computer. They will be sent to the
> school automatically when the internet is switched back on.*

They do not have to wait for anything. If a student runs out of time, the exam submits itself
with whatever is answered and says so.

## After the sitting

**6. Switch the internet back on.** Leave the machines **on and signed in**. Each one starts
sending by itself within a minute.

**7. Check each machine's Sync screen** (the **Sync** button in the header, or
`exam.shulesoft.africa/sync` — it opens with nobody signed in too).

You want:

> **Everything on this computer has reached the school. It is safe to shut this machine down.**

Until then it will say how many exams are still waiting. The table lists every student on
that machine, because the last shift's work must go up before the machine is wiped or reset.

## If something is wrong

| What you see | What it means | What to do |
|---|---|---|
| **Waiting to send** | Normal. The queue has not been drained yet. | Leave the machine on and connected; press **Sync now** if you are in a hurry. |
| **Sending…** | It is uploading right now. | Wait. Large photographs take longest. |
| **Needs the teacher** | The server refused something, or the upload failed too many times. The answers are **still safe on the machine**. | Press **Retry failed** once the internet is definitely working. If it stays flagged, press **Export diagnostics** and send that file to ICT. |
| **"A student's sign-in on this computer has expired"** | The exam is fine; the login is too old. | Ask that student to sign in again on that machine. The exam then sends itself. |
| **"This browser has not granted persistent storage"** | The browser has not promised to keep the data. It still saves it. | Make sure the machines are used with the same profile and are not wiped between shifts. Sync as soon as the sitting ends. |
| A student cannot sign in with the internet off | Normal — a first sign-in needs the network. | Switch the internet on for that machine, let them sign in and download, then switch it off again. |
| A machine will not open the app at all with the internet off | It was never opened online on that machine. | Switch the internet on, open the app once, then off again. |

**Never** clear the browser data, reset the profile or re-image a machine while its Sync
screen still shows exams waiting. That is the only way to lose work.

## What the school sees afterwards

Synced attempts appear exactly where online attempts already do: the student's answers in the
Online Exam module, the mark in the exam report, and anything only a teacher can mark (written
answers with no model answer, and attached files) in the teacher's "still to mark" list.
