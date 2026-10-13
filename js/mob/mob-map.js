// Colour per MOB object type (shared with the SEC map overlay).


export function mobMapTypeColor(type) { return `hsl(${(type * 47) % 360}, 70%, 60%)`; }
