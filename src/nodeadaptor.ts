export type NodeAdapter<T> = {
  type: string;
  matches(x: any): x is T;
  key?(x: T): string | undefined;
  id?(x: T): string | undefined;
  deps?(x: T): any[];
  toJSON(x: T, ref: (child: any) => { $ref: string }): any;
  fromJSON(data: any, get: (key: string) => any): T;
};
