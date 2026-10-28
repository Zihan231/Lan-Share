import { useState } from 'react';
import { cx } from '../common/ui';

const GROUPS: Array<{ id: string; icon: string; label: string; emojis: string }> = [
  { id: 'smileys', icon: '😀', label: 'Smileys', emojis: '😀😃😄😁😆😅😂🤣🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🤧🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁☹️😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡👻👽🤖' },
  { id: 'people', icon: '👋', label: 'People', emojis: '👋🤚🖐️✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍️💅🤳💪🦾🧠👀👁️👅👄🧑👨👩🧓👶🙋🤷🙆🙅💁🤦🙇' },
  { id: 'nature', icon: '🐶', label: 'Animals', emojis: '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🐢🐍🦎🐙🦑🦀🐠🐟🐬🐳🦈🌵🎄🌲🌳🌴🌱🌿☘️🍀🍁🍂🍃🌺🌸🌼🌻🌞🌝🌛⭐🌟✨⚡🔥🌈☀️⛅☁️❄️💧🌊' },
  { id: 'food', icon: '🍕', label: 'Food', emojis: '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥝🍅🥑🥦🥕🌽🌶️🥔🍞🥐🧀🍳🥞🥓🍔🍟🍕🌭🥪🌮🌯🥗🍝🍜🍣🍤🍩🍪🎂🍰🍫🍬🍭☕🍵🥤🍺🍻🥂🍷' },
  { id: 'activity', icon: '⚽', label: 'Activity', emojis: '⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥅⛳🏹🎣🥊🥋🎽🛹⛸️🎿🏂🏋️🤸🏊🚴🏆🥇🥈🥉🏅🎖️🎯🎮🕹️🎲🧩🎭🎨🎬🎤🎧🎼🎹🥁🎸🎻' },
  { id: 'objects', icon: '💡', label: 'Objects', emojis: '⌚📱💻⌨️🖥️🖨️🖱️💾💿📷📸🎥📺📻⏰🔋🔌💡🔦📚📖📝✏️📌📎✂️🗂️📁📂🗃️🔒🔓🔑🛠️🔧🔨⚙️🧰💰💳📦📫📬🎁🎈🎉🎊' },
  { id: 'symbols', icon: '❤️', label: 'Symbols', emojis: '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝✅❌⭕❗❓‼️⁉️💯🔔🔕➕➖➗✖️♻️✔️☑️🔴🟠🟡🟢🔵🟣⚫⚪🟥🟧🟨🟩🟦🟪⬛⬜▶️⏸️⏯️⏹️⏺️🔁🔂🔀' },
];

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function split(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [group, setGroup] = useState(GROUPS[0].id);
  const g = GROUPS.find((x) => x.id === group)!;
  return (
    <div className="pop w-[19rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-2 shadow-2xl" role="dialog" aria-label="Emoji picker">
      <div className="mb-1 flex gap-1 border-b border-line pb-1" role="tablist">
        {GROUPS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={x.id === group}
            aria-label={x.label}
            title={x.label}
            onClick={() => setGroup(x.id)}
            className={cx('flex h-8 flex-1 items-center justify-center rounded-md text-lg', x.id === group ? 'bg-brand-soft' : 'hover:bg-surface-2')}
          >
            {x.icon}
          </button>
        ))}
      </div>
      <div className="scroll-thin grid h-52 grid-cols-8 content-start gap-0.5 overflow-y-auto">
        {split(g.emojis).map((e, i) => (
          <button key={e + i} type="button" onClick={() => onPick(e)} className="flex h-9 items-center justify-center rounded-md text-xl hover:bg-surface-2" aria-label={`Insert ${e}`}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
