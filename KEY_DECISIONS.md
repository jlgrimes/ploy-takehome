# Key decisions
UI - kept it simple with the Vercel AI elements powering the main interface of the chat. Home page is simple - authenticated as default user, then each of the campaign editors features the artifact being created on the right, and the chat on the left - very similar to a ton of AI things like Claude artifacts, etc.

Model layer - I used Jev for the feedback decision layer, because of the impressive speed gain we get by returning a boolean decision (ie where in the pipeline we need to regenerate everything from), Haiku + Sonnet for the cheaper stuff, text generation, chat handling.

How the ad is generated - I wanted to leave as little to the FAL as possible due to text hallucinations, so I gave explicit instructions to not generate any text, and didn’t have text as part of the FAL process. instead, I simply 