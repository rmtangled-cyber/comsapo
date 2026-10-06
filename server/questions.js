// STEP 1: questions every participant answers privately before the AI interview.
export const COMMON_QUESTIONS = [
  { id: 'feeling', text: '今、このテーマについてどんな気持ちですか？', placeholder: '例：モヤモヤしている、少し寂しい、疲れている…' },
  { id: 'gratitude', text: '相手に感謝していること・尊敬しているところは？', placeholder: '小さなことでも大丈夫です' },
  { id: 'hurt', text: '今回、嫌だったこと・つらかったことは？', placeholder: '思ったまま書いて大丈夫です。相手にそのまま見せることはありません' },
  { id: 'wish', text: '本当はどうしてほしかったですか？', placeholder: '' },
  { id: 'self', text: '自分にも改善できるところはありそうですか？', placeholder: '思いつかなければ「わからない」でもOKです' },
  { id: 'goal', text: '最終的に、2人がどういう状態になれたら嬉しいですか？', placeholder: '' },
];

export const MAX_ANSWER_LENGTH = 2000;
